# Examples

Each example is a standalone package with its own `package.json` and run
instructions. Examples that use local agent-fs packages depend on them through
relative `file:` dependencies so they can run from the monorepo without waiting
for an npm publish.

## Available Examples

- [`just-bash-agent-fs`](./just-bash-agent-fs) - use agent-fs as the filesystem
  implementation for a `just-bash` shell.
