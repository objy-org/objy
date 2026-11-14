# Project instructions

The user explicitly requires local-only development and testing for OBJY Studio.

- This UI is part of the parent OBJY server Git repository. Use this UI directory and serve its `dist/` on localhost (currently http://127.0.0.1:4317/).
- Do not publish, deploy, push source to hosting, or create remote previews unless the user explicitly requests it.
- Preserve the local implementation when taking a hosted deployment offline.
- Keep OBJY database objects in memory; do not add persistence without an explicit request.
