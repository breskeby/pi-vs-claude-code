# pi-agent-chain — bootstrap distribution

A self-contained pi package that ships **only** the `/agent-chain` extension
along with its custom agents and chain configuration. No other extensions,
no themes, no skills.

## Contents

```
packages/agent-chain/
├── package.json                         # pi-package manifest
├── extensions/
│   ├── agent-chain.ts                   # the extension
│   └── themeMap.ts                      # no-op stub (agent-chain imports it)
└── .pi/agents/
    ├── agent-chain.yaml                 # chain definitions
    ├── planner.md
    ├── builder.md
    ├── reviewer.md
    ├── plan-reviewer.md
    └── scout.md
```

Only the agents referenced by `agent-chain.yaml` are bundled: `planner`,
`builder`, `reviewer`, `plan-reviewer`, `scout`.

## Bootstrap

### One-liner (installs pi + this package)

```bash
curl -fsSL https://raw.githubusercontent.com/<user>/<repo>/main/packages/agent-chain/bootstrap.sh | bash
```

Or locally:

```bash
bash packages/agent-chain/bootstrap.sh
```

### From npm (pi already installed)

```bash
pi install npm:pi-agent-chain            # global
pi install -l npm:pi-agent-chain         # project only
```

### Try it once without installing

```bash
pi -e ./packages/agent-chain
# or from npm without permanent install:
pi -e npm:pi-agent-chain
```

### From a local path

```bash
pi install ./packages/agent-chain        # global
pi install -l ./packages/agent-chain     # project
```

## Publishing

```bash
just publish-agent-chain-dry   # dry run
just publish-agent-chain       # publish to npm
```

## How it finds agents and chains

`extensions/agent-chain.ts` resolves `PACKAGE_ROOT` from `import.meta.url`,
so it automatically picks up `.pi/agents/agent-chain.yaml` and the agent
markdown files bundled inside this package. The lookup order is:

1. `<cwd>/.pi/agents/`
2. `$PI_CODING_AGENT_DIR/agents/` (defaults to `~/.pi/agent/agents/`)
3. `<package_root>/.pi/agents/` ← this package

Local project overrides therefore still win.

## Commands

- `/chain` — switch the active chain
- `/chain-list` — list available chains

See `extensions/agent-chain.ts` header for full documentation.
