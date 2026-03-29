#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const INDEX_PATH = path.join(__dirname, 'index.html');
const LEVELS = ['NONE', 'FIRST_QUARTILE', 'SECOND_QUARTILE', 'THIRD_QUARTILE', 'FOURTH_QUARTILE'];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

async function fetchYear(username, year) {
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

async function main() {
  const indexHtml = await fs.readFile(INDEX_PATH, 'utf8');
  const username = parseUsername(indexHtml);
  const currentYear = new Date().getFullYear();
  const years = [currentYear, currentYear - 1];

  const entries = await Promise.all(
    years.map(async (year) => [year, await fetchYear(username, year)]),
  );

  const payload = {
    username,
    syncedAt: new Date().toISOString(),
    years: Object.fromEntries(entries),
  };

  const replacement = `const DATA = ${JSON.stringify(payload, null, 2)};`;
  const updatedHtml = indexHtml.replace(/const DATA = [\s\S]*?;\n\nconst MONTHS = /, `${replacement}\n\nconst MONTHS = `);

  if (updatedHtml === indexHtml) {
    throw new Error('Could not replace DATA block in index.html');
  }

  await fs.writeFile(INDEX_PATH, updatedHtml, 'utf8');
  process.stdout.write(`Synced GitHub contributions for @${username} (${years.join(', ')})\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
