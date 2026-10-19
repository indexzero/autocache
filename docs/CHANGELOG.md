# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### 🆕 Added
- **GitHub repo-root probe before a deep-link 404 counts as gone**: `backfill` and `generate` probe the repo root of a `github.com` deep link that the archive lacks, and a renamed repo becomes a rewrite candidate (`.refetch/renamed.jsonl`, `manifest.rewrites`). A default port (`github.com:80`) still matches, and an inconclusive reply (403, 408, 429, 5xx) defers instead of writing a terminal record. (#13)
