# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### 🆕 Added
- **GitHub repo-root probe before a deep-link 404 counts as gone**: `backfill` and `generate` probe the repo root of a `github.com` deep link that the archive lacks. A renamed repo becomes a rewrite candidate (`.refetch/renamed.jsonl`, `manifest.rewrites`), and a default port (`github.com:80`) still matches. An inconclusive reply defers the link instead of writing a terminal record. Inconclusive replies are a 403, 408, 429, or 5xx, a redirect off GitHub or without a Location, and a network error. (#13)
