# SumPlus

SumPlus is the customized TeleBox group summary plugin for the `.sum` and `.summary` commands.

## Install

1. Copy `plugins/sumplus.ts` into the target TeleBox `plugins/` directory.
2. Disable the official `plugins/sum.ts` plugin if it exists, otherwise both plugins may respond to `.sum`.
3. Restart TeleBox.
4. Configure providers with `.sum key`, `.sum url`, `.sum model`, or edit `assets/sum/config.json`.

## Notes

- SumPlus intentionally reuses `assets/sum/config.json` and `assets/sum/identity-cache.json`.
- The official `plugins/sum.ts` is disabled in this fork; SumPlus owns `.sum` and `.summary`.
