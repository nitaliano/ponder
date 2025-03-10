## Benchmarks (WIP)

This directory contains tooling to benchmark Ponder against the Graph Protocol's [Graph Node](https://github.com/graphprotocol/graph-node).

### Run benchmarks locally

To run benchmarks locally, just run `pnpm bench` in this directory or at the workspace root. This command uses `docker-compose` to start a Graph Node instance, then runs `src/bench.ts` to run the benchmarks. The script builds and deploys a subgraph to the Graph Node and records how long it takes for the subgraph to sync, as well as how many RPC requests were made. Then, it runs a

### Run benchmarks in CI

The `.github/workflows/bench.yml` workflow runs benchmarks in CI. Instead of using `docker-compose`, it sets up a Graph Node using GitHub Action services. Other than that, it's the same as local. _Note: the benchmarks workflow is currently only triggered manually through the GitHub Actions UI (must have write access to the repo)._
