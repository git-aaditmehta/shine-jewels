# Cloudflare free tier guard

This project must remain within Cloudflare free-tier allowances.

- Do not upgrade plans or enable paid products automatically.
- Use only the existing Worker, D1 database and R2 bucket.
- Keep cloud integration fixtures small and delete them after verification.
- Do not run 10,000-image, multi-gigabyte, or sustained-load tests against live Cloudflare resources.
- Use local SQLite WASM/OPFS and synthetic fixtures for development and later controlled test plans.
- Stop and request approval before any operation that could require a paid plan or create material billable usage.
