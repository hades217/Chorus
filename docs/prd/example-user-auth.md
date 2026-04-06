---
title: User Authentication Redesign
date: 2026-04-06
status: in-progress
owner: "@alice"
priority: high
tags: [backend, auth]
---

## Background / Context

Current authentication uses session cookies with a 24-hour expiry. Users report frequent logouts during long work sessions, and we have no support for third-party OAuth providers.

## Goals

- Reduce session-related support tickets by 80%
- Add Google and GitHub OAuth login options
- Maintain backward compatibility with existing sessions

## Non-goals

- Enterprise SSO (SAML/OIDC) — planned for Q3
- Biometric authentication

## Requirements

### Functional

- JWT-based authentication with refresh tokens
- Google OAuth2 login
- GitHub OAuth login
- Graceful migration from cookie sessions to JWT

### Non-functional

- Token refresh must complete in <100ms
- Support 10,000 concurrent authenticated users

## Acceptance Criteria

- [x] JWT token generation and validation
- [x] Refresh token rotation
- [ ] Google OAuth2 integration
- [ ] GitHub OAuth integration
- [ ] Session migration script
- [ ] Rate limiting on auth endpoints (10 req/min per IP)

## Test Plan

- [ ] Unit tests for token service
- [ ] Integration tests for OAuth flow
- [ ] Load test: 10k concurrent users
- [ ] Manual test: login → refresh → logout cycle
