#!/bin/bash
node "$(dirname "$0")/sync.mjs" || true
open "$(dirname "$0")/index.html"
