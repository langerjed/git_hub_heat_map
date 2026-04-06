#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const INDEX_PATH = path.join(__dirname, 'index.html');
const TIME_ZONE = 'America/New_York';
const LEVELS = ['NONE', 'FIRST_QUARTILE', 'SECOND_QUARTILE', 'THIRD_QUARTILE', 'FOURTH_QUARTILE'];
const TOKEN = process.env.GITHUB_TOKEN || '';
const EASTERN_DAY_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function formatEasternDay(value) {
  return EASTERN_DAY_FORMATTER.format(new Date(value));
}

function buildYearDays(year) {
  const days = [];
  const cursor = new Date(Date.UTC(year, 0, 1, 12));

  while (true) {
    const key = formatEasternDay(cursor);
    if (key > `${year}-12-31`) break;
    if (key >= `${year}-01-01`) days.push(key);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return days;
}

function parseUsername(html) {
  const altMatch = html.match(/<img class="avatar"[^>]*alt="([^"]+)"/i);
  if (altMatch) return altMatch[1];

  const handleMatch = html.match(/<p>@([^<\s&]+)/i);
  if (handleMatch) return handleMatch[1];

  throw new Error('Could not determine GitHub username from index.html');
}

function parseTotalContributions(html, year) {
  const totalMatch = html.match(
    new RegExp(`<h2[^>]*>[\\s\\S]*?([\\d,]+)\\s+contributions\\s+in\\s+${year}`, 'i'),
  );
  if (!totalMatch) {
    throw new Error(`Could not find total contributions for ${year}`);
  }

  return Number.parseInt(totalMatch[1].replace(/,/g, ''), 10);
}

function parseContributionDays(html) {
  const dayRegex =
    /<td\b[^>]*data-date="([^"]+)"[^>]*data-level="([^"]+)"[^>]*><\/td>\s*<tool-tip[^>]*>([\s\S]*?)<\/tool-tip>/g;

  const days = [];
  let match;
  while ((match = dayRegex.exec(html)) !== null) {
    const [, date, levelIndex, tooltipText] = match;
    const normalizedTip = tooltipText.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const countMatch = normalizedTip.match(/([\d,]+)\s+contribution/i);
    const contributionCount = countMatch ? Number.parseInt(countMatch[1].replace(/,/g, ''), 10) : 0;
    const contributionLevel = LEVELS[Number.parseInt(levelIndex, 10)] ?? 'NONE';
    days.push({ date, contributionCount, contributionLevel });
  }

  if (days.length === 0) {
    throw new Error('Could not parse contribution days from GitHub response');
  }

  days.sort((a, b) => a.date.localeCompare(b.date));
  return days;
}

function restHeaders(extra = {}) {
  const headers = {
    'User-Agent': 'github-heatmap-sync',
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...extra,
  };

  if (TOKEN) {
    headers.Authorization = `Bearer ${TOKEN}`;
  }

  return headers;
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: restHeaders() });
  if (!response.ok) {
    throw new Error(`GitHub API request failed: ${response.status} ${response.statusText} for ${url}`);
  }
  return response.json();
}

async function fetchGraphQL(query, variables = {}) {
  if (!TOKEN) {
    return null;
  }

  const response = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: restHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw new Error(`GitHub GraphQL request failed: ${response.status} ${response.statusText}`);
  }

  const payload = await response.json();
  if (payload.errors?.length) {
    throw new Error(payload.errors.map((error) => error.message).join('; '));
  }

  return payload.data;
}

async function fetchAllPages(urlBuilder) {
  const rows = [];
  for (let page = 1; page <= 10; page += 1) {
    const pageRows = await fetchJson(urlBuilder(page));
    if (!Array.isArray(pageRows) || pageRows.length === 0) break;
    rows.push(...pageRows);
    if (pageRows.length < 100) break;
  }
  return rows;
}

async function fetchSearchCount(query) {
  const url = `https://api.github.com/search/issues?q=${encodeURIComponent(query)}&per_page=1`;
  const payload = await fetchJson(url);
  return payload.total_count ?? 0;
}

async function fetchContributionYear(username, year) {
  const url = `https://github.com/users/${username}/contributions?from=${year}-01-01&to=${year}-12-31`;
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'github-heatmap-sync',
      Accept: 'text/html',
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub request failed for ${year}: ${response.status} ${response.statusText}`);
  }

  const html = await response.text();
  return {
    totalContributions: parseTotalContributions(html, year),
    days: parseContributionDays(html),
  };
}

async function fetchContributionSummary(username) {
  if (!TOKEN) return null;

  const query = `
    query ContributionSummary($login: String!) {
      user(login: $login) {
        contributionsCollection {
          contributionYears
          restrictedContributionsCount
          totalCommitContributions
          totalIssueContributions
          totalPullRequestContributions
          totalPullRequestReviewContributions
          totalRepositoryContributions
          hasAnyRestrictedContributions
          earliestRestrictedContributionDate
          latestRestrictedContributionDate
          commitContributionsByRepository(maxRepositories: 12) {
            contributions(first: 100) {
              totalCount
            }
            repository {
              nameWithOwner
              url
              isPrivate
              stargazerCount
              primaryLanguage {
                name
              }
            }
          }
        }
      }
    }
  `;

  const data = await fetchGraphQL(query, { login: username });
  const collection = data?.user?.contributionsCollection;
  if (!collection) return null;

  return {
    years: collection.contributionYears || [],
    restrictedCount: collection.restrictedContributionsCount || 0,
    hasRestricted: Boolean(collection.hasAnyRestrictedContributions),
    earliestRestrictedDate: collection.earliestRestrictedContributionDate,
    latestRestrictedDate: collection.latestRestrictedContributionDate,
    totals: {
      commits: collection.totalCommitContributions || 0,
      issues: collection.totalIssueContributions || 0,
      pullRequests: collection.totalPullRequestContributions || 0,
      reviews: collection.totalPullRequestReviewContributions || 0,
      repositories: collection.totalRepositoryContributions || 0,
    },
    topContributionRepos: (collection.commitContributionsByRepository || []).map((entry) => ({
      name: entry.repository?.nameWithOwner || 'unknown',
      url: entry.repository?.url || '',
      commits: entry.contributions?.totalCount || 0,
      visibility: entry.repository?.isPrivate ? 'private' : 'public',
      stars: entry.repository?.stargazerCount || 0,
      language: entry.repository?.primaryLanguage?.name || '',
    })),
  };
}

async function fetchRecentCommits(username, repos) {
  if (!TOKEN) {
    return {
      totalRecentCommits: 0,
      commits: [],
      note: 'Add GITHUB_TOKEN to include recent commits across private and public repos.',
    };
  }

  const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
  const commits = [];

  for (const repo of repos.slice(0, 30)) {
    const repoName = repo.full_name;
    const url = `https://api.github.com/repos/${repoName}/commits?author=${encodeURIComponent(username)}&since=${encodeURIComponent(since)}&per_page=10`;
    try {
      const repoCommits = await fetchJson(url);
      for (const commit of repoCommits) {
        commits.push({
          repo: repoName,
          url: commit.html_url,
          message: commit.commit?.message?.split('\n')[0] || 'Commit',
          committedAt: commit.commit?.author?.date || commit.commit?.committer?.date,
          sha: commit.sha?.slice(0, 7) || '',
        });
      }
    } catch (error) {
      // Skip repos that reject commit listing for scope or visibility reasons.
    }
  }

  commits.sort((a, b) => new Date(b.committedAt) - new Date(a.committedAt));
  return {
    totalRecentCommits: commits.length,
    commits: commits.slice(0, 12),
    note: 'Recent commits are pulled directly from your repositories over the last 14 days.',
  };
}

function buildHeatLevel(count, maxCount) {
  if (!count) return 'NONE';
  if (maxCount <= 1) return 'FOURTH_QUARTILE';

  const ratio = count / maxCount;
  if (ratio >= 0.75) return 'FOURTH_QUARTILE';
  if (ratio >= 0.5) return 'THIRD_QUARTILE';
  if (ratio >= 0.25) return 'SECOND_QUARTILE';
  return 'FIRST_QUARTILE';
}

async function fetchCommitHeatmap(username, repos, years) {
  const minYear = Math.min(...years);
  const since = `${minYear}-01-01T00:00:00Z`;
  const dayCounts = new Map();

  for (const repo of repos.slice(0, 40)) {
    for (let page = 1; page <= 10; page += 1) {
      const url = `https://api.github.com/repos/${repo.full_name}/commits?author=${encodeURIComponent(username)}&since=${encodeURIComponent(since)}&per_page=100&page=${page}`;
      let repoCommits = [];
      try {
        repoCommits = await fetchJson(url);
      } catch (error) {
        break;
      }

      if (!Array.isArray(repoCommits) || repoCommits.length === 0) break;

      for (const commit of repoCommits) {
        const committedAt = commit.commit?.author?.date || commit.commit?.committer?.date;
        if (!committedAt) continue;
        const day = formatEasternDay(committedAt);
        dayCounts.set(day, (dayCounts.get(day) || 0) + 1);
      }

      if (repoCommits.length < 100) break;
    }
  }

  const payload = {};

  for (const year of years) {
    const days = [];
    let totalContributions = 0;
    let maxCount = 0;

    for (const key of buildYearDays(year)) {
      const count = dayCounts.get(key) || 0;
      totalContributions += count;
      maxCount = Math.max(maxCount, count);
      days.push({
        date: key,
        contributionCount: count,
      });
    }

    payload[year] = {
      totalContributions,
      days: days.map((day) => ({
        ...day,
        contributionLevel: buildHeatLevel(day.contributionCount, maxCount),
      })),
    };
  }

  return payload;
}

async function fetchRepos(username) {
  const base = TOKEN
    ? (page) =>
        `https://api.github.com/user/repos?per_page=100&page=${page}&sort=updated&direction=desc&affiliation=owner,collaborator,organization_member`
    : (page) =>
        `https://api.github.com/users/${username}/repos?per_page=100&page=${page}&sort=updated&direction=desc&type=owner`;

  const repos = await fetchAllPages(base);
  const owned = repos.filter((repo) => repo.owner?.login?.toLowerCase() === username.toLowerCase());
  const topRepos = owned
    .slice()
    .sort((a, b) => new Date(b.pushed_at) - new Date(a.pushed_at))
    .slice(0, 6)
    .map((repo) => ({
      name: repo.full_name,
      url: repo.html_url,
      description: repo.description || '',
      pushedAt: repo.pushed_at,
      stars: repo.stargazers_count,
      forks: repo.forks_count,
      language: repo.language || '',
      visibility: repo.private ? 'private' : 'public',
      defaultBranch: repo.default_branch,
    }));

  return {
    rawOwned: owned,
    totalOwned: owned.length,
    publicOwned: owned.filter((repo) => !repo.private).length,
    privateOwned: owned.filter((repo) => repo.private).length,
    totalStars: owned.reduce((sum, repo) => sum + (repo.stargazers_count || 0), 0),
    totalForks: owned.reduce((sum, repo) => sum + (repo.forks_count || 0), 0),
    recent: topRepos,
  };
}

async function fetchEvents(username) {
  const events = await fetchAllPages(
    (page) => `https://api.github.com/users/${username}/events/public?per_page=100&page=${page}`,
  );

  const pushEvents = events.filter((event) => event.type === 'PushEvent');
  const byType = {};
  for (const event of events) {
    byType[event.type] = (byType[event.type] || 0) + 1;
  }

  const reposTouched = new Set(events.map((event) => event.repo?.name).filter(Boolean));
  const commitsInPushes = pushEvents.reduce((sum, event) => sum + (event.payload?.size || 0), 0);
  const recentPushes = pushEvents.slice(0, 8).map((event) => ({
    repo: event.repo?.name || 'unknown',
    url: event.repo?.name ? `https://github.com/${event.repo.name}` : '',
    createdAt: event.created_at,
    commits: event.payload?.size || 0,
    branch: String(event.payload?.ref || '').replace('refs/heads/', ''),
  }));

  return {
    totalPublicEvents: events.length,
    publicPushEvents: pushEvents.length,
    publicPushCommits: commitsInPushes,
    reposTouched: reposTouched.size,
    recentPushes,
    byType,
    note: 'Recent activity is based on the public events feed and is limited by GitHub to the latest public events.',
  };
}

async function buildAggregate(username) {
  const [repos, pullsOpened, pullsMerged, issuesOpened, events, contributionSummary] = await Promise.all([
    fetchRepos(username),
    fetchSearchCount(`author:${username} is:pr`),
    fetchSearchCount(`author:${username} is:pr is:merged`),
    fetchSearchCount(`author:${username} is:issue`),
    fetchEvents(username),
    fetchContributionSummary(username),
  ]);

  const recentCommits = await fetchRecentCommits(username, repos.rawOwned || []);

  return {
    scope: TOKEN ? 'token' : 'public',
    note: TOKEN
      ? 'Broader rollup includes repositories and contribution data visible to your token, including private repos when your token and GitHub profile settings allow it.'
      : 'Broader rollup is based on public GitHub data only. Add GITHUB_TOKEN before syncing if you want private repositories included.',
    repos: {
      totalOwned: repos.totalOwned,
      publicOwned: repos.publicOwned,
      privateOwned: repos.privateOwned,
      totalStars: repos.totalStars,
      totalForks: repos.totalForks,
      recent: repos.recent,
    },
    pulls: {
      opened: pullsOpened,
      merged: pullsMerged,
    },
    issues: {
      opened: issuesOpened,
    },
    events,
    recentCommits,
    contributionSummary,
  };
}

async function main() {
  const indexHtml = await fs.readFile(INDEX_PATH, 'utf8');
  const username = parseUsername(indexHtml);
  const currentYear = new Date().getFullYear();
  const years = [currentYear, currentYear - 1];
  const repoInventory = TOKEN ? await fetchRepos(username) : null;

  const [aggregate, entries, customHeatmap] = await Promise.all([
    buildAggregate(username),
    Promise.all(years.map(async (year) => [year, await fetchContributionYear(username, year)])),
    TOKEN ? fetchCommitHeatmap(username, repoInventory?.rawOwned || [], years) : Promise.resolve(null),
  ]);

  const payload = {
    username,
    syncedAt: new Date().toISOString(),
    timeZone: TIME_ZONE,
    aggregate,
    heatmapMode: customHeatmap ? 'all-commits' : 'official',
    officialYears: Object.fromEntries(entries),
    years: customHeatmap || Object.fromEntries(entries),
  };

  const replacement = `const DATA = ${JSON.stringify(payload, null, 2)};`;
  const updatedHtml = indexHtml.replace(/const DATA = [\s\S]*?;\n\nconst MONTHS = /, `${replacement}\n\nconst MONTHS = `);

  if (updatedHtml === indexHtml) {
    throw new Error('Could not replace DATA block in index.html');
  }

  await fs.writeFile(INDEX_PATH, updatedHtml, 'utf8');
  process.stdout.write(`Synced GitHub dashboard for @${username} (${years.join(', ')})\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
