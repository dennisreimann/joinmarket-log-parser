# JoinMarket Log Parser

Parses the files in a [JoinMarket](https://github.com/JoinMarket-Org/joinmarket-clientserver) log folder and turns the log entries of notable events into structured JSON.
You can use this for internal accounting or analysing/checking the state of your JoinMarket wallet.

Requirements:

- [Node.js](https://nodejs.org/)

Usage:

```bash
node joinmarket-log-parser.mjs ./logs joinmarket.json
```
