---
title: API Rate Limiting
date: 2026-04-05
status: draft
owner: "@charlie"
priority: critical
tags: [backend, infrastructure]
---

## Background / Context

Our public API currently has no rate limiting. A single misconfigured client caused a 15-minute outage last week by sending 50k requests/minute.

## Goals

- Prevent any single client from degrading service for others
- Provide clear error messages when limits are hit
- Allow different limits per API tier (free, pro, enterprise)

## Acceptance Criteria

- [ ] Token bucket rate limiter middleware
- [ ] Per-API-key limits configurable via environment variables
- [ ] 429 Too Many Requests response with Retry-After header
- [ ] Rate limit headers on every response (X-RateLimit-Remaining, etc.)
- [ ] Dashboard showing current usage per key

## Test Plan

- [ ] Unit tests for token bucket algorithm
- [ ] Integration test: exceed limit → get 429
- [ ] Load test: verify limits hold under 100k req/min
