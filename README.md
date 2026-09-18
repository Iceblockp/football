# Football Bet POS

Offline Electron desktop app for recording football Body and O/U bets and producing daily settlement reports.

## Included in this first version

- Match setup with any number of Body or O/U rules per match.
- Flexible rule engine: configure the display code, line, and outcome for **below / equal / above** the line. Each outcome can be win, loss, or refund with its own percentage.
- Body selections (left/home or right/away) and O/U selections (Up or Down).
- Result entry and `P:P` postponed/refund support.
- Bet ledger with a separate stake amount field; no customer/user field is required.
- Daily report totals with configurable win deduction and commission. Commission is calculated from `gross WIN + absolute gross LOSE`, matching the supplied record format.
- Excel-compatible UTF-8 CSV and PDF export.
- Local data storage in Electron's application-data directory.

## Start

```sh
npm install
npm run dev
```

For a production build:

```sh
npm run build
npm run start
```

## Windows installer via GitHub Actions

The workflow in `.github/workflows/build-windows.yml` builds an unsigned NSIS
Windows installer. Push this project to GitHub, then either run **Build Windows
installer** manually from the Actions tab or push a version tag such as `v0.1.0`.
Download `Football-Bet-POS-Windows` from that workflow run's artifacts.

## Settlement configuration

Do not rely solely on parsing labels such as `1D`, `1+80`, or `2-60`. When creating a match, configure each rule explicitly:

| Situation | Configurable outcome |
| --- | --- |
| Result below line | full/partial win, full/partial loss, or refund |
| Result exactly on line | full/partial win, full/partial loss, or refund |
| Result above line | full/partial win, full/partial loss, or refund |

This accommodates existing and future house rules without changing code.
