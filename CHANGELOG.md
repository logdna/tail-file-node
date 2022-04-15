# 2022-04-15, Version 2.2.0 (Stable)

* [[9dbe1edf07](https://github.com/logdna/tail-file-node/commit/9dbe1edf07)] - fix: `destroyOnReturn` backward compatibility for node (Darin Spivey)
* [[860045ec12](https://github.com/logdna/tail-file-node/commit/860045ec12)] - **(SEMVER-MINOR)** fix: Necessary changes for asyncIterators in recent version of node (Darin Spivey)
* [[a6dc7baa3d](https://github.com/logdna/tail-file-node/commit/a6dc7baa3d)] - fix: Fix flakey test (Darin Spivey)
* [[215b293099](https://github.com/logdna/tail-file-node/commit/215b293099)] - fix: Bump node versions for CI (Darin Spivey)
* [[b9453b39d4](https://github.com/logdna/tail-file-node/commit/b9453b39d4)] - fix: README should explain a clean shutdown (Darin Spivey)

# 2022-03-14, Version 2.1.1 (Stable)

* [[feb1886d1c](https://github.com/logdna/tail-file-node/commit/feb1886d1c)] - ci: `GITHUB_PACKAGES_TOKEN` to `GITHUB_TOKEN` (Charles Thomas) [REL-731](https://logdna.atlassian.net/browse/REL-731)

# 2021-06-08, Version 2.1.0 (Stable)

* [[91762e0644](https://github.com/logdna/tail-file-node/commit/91762e0644)] - **(SEMVER-MINOR)** feat: Include `lastReadPosition` in the `flush` event (Darin Spivey)
* [[165c5c95f2](https://github.com/logdna/tail-file-node/commit/165c5c95f2)] - fix: Fix test that causes a GC warning (Darin Spivey)

# 2021-06-02, Version 2.0.7 (Stable)

* [[558e3233bf](https://github.com/logdna/tail-file-node/commit/558e3233bf)] - deps: tap@15.0.9 (Darin Spivey)
* [[01b7dd722f](https://github.com/logdna/tail-file-node/commit/01b7dd722f)] - deps: eslint-config-logdna@5.1.0 (Darin Spivey)
* [[36de02bc9e](https://github.com/logdna/tail-file-node/commit/36de02bc9e)] - deps: eslint@7.27.0 (Darin Spivey)
* [[08c8472cbf](https://github.com/logdna/tail-file-node/commit/08c8472cbf)] - fix: Error on rotated file if new file takes time to appear (Darin Spivey)
* [[14faefe57e](https://github.com/logdna/tail-file-node/commit/14faefe57e)] - refactor: memory-usage tests should use a temp directory (Darin Spivey)

# 2021-02-09, Version 2.0.6 (Stable)

* [[b4934ce398](https://github.com/logdna/tail-file-node/commit/b4934ce398)] - fix: Move default branch to `main` and add contributors (Darin Spivey)

# 2021-02-05, Version 2.0.5 (Stable)

* [[f22aa14479](https://github.com/logdna/tail-file-node/commit/f22aa14479)] - docs: Fix bug in README example for `pipe` (Darin Spivey)

# 2021-01-20, Version 2.0.4 (Stable)

* [[ca30b46c46](https://github.com/logdna/tail-file-node/commit/ca30b46c46)] - fix: Use accurate export style in TypeScript types (Jakub Jirutka)

# 2020-12-21, Version 2.0.3 (Stable)

* [[ee4808a09e](https://github.com/logdna/tail-file-node/commit/ee4808a09e)] - feat: add TypeScript type declarations (Jakub Jirutka)

# 2020-12-03, Version 2.0.2 (Stable)

* [[192f4c1dee](https://github.com/logdna/tail-file-node/commit/192f4c1dee)] - test: Add tap-xunit and flatten results for junit output (Darin Spivey)

# 2020-11-24, Version 2.0.1 (Stable)

* [[167a6230cb](https://github.com/logdna/tail-file-node/commit/167a6230cb)] - fix: Specify 'r' flag for fs.promises.open (Darin Spivey)

# 2020-11-16, Version 2.0.0 (Stable)

* [[b05648c8c0](https://github.com/logdna/tail-file-node/commit/b05648c8c0)] - **(SEMVER-MAJOR)** refactor: `start()` should throw if filename doesn't exist (Darin Spivey) [LOG-8030](https://logdna.atlassian.net/browse/LOG-8030)

# 2020-11-02, Version 1.1.0 (Stable)

* [[9e4061f43b](https://github.com/logdna/tail-file-node/commit/9e4061f43b)] - **(SEMVER-MINOR)** feat: startPos allows specifying the position to tail from (Darin Spivey) [LOG-7789](https://logdna.atlassian.net/browse/LOG-7789)

# 2020-10-28, Version 1.0.3 (Stable)

* [[157194e166](https://github.com/logdna/tail-file-node/commit/157194e166)] - fix: add PR validation to Jenkinsfile (Ryan Mottley) [LOG-7717](https://logdna.atlassian.net/browse/LOG-7717)

# 2020-10-22, Version 1.0.2 (Stable)

* [[e485c246f7](https://github.com/logdna/tail-file-node/commit/e485c246f7)] - feat(contrib): add initial CONTRIBUTING file (Laura Santamaria)

# 2020-10-15, Version 1.0.1 (Stable)

* [[b21c051b77](https://github.com/logdna/tail-file-node/commit/b21c051b77)] - fix: CI needs custom work spaces for release stages (Darin Spivey)
* [[d1c9466aa2](https://github.com/logdna/tail-file-node/commit/d1c9466aa2)] - fix: Add test to .npmignore (Darin Spivey)
* [[2f02a9f39f](https://github.com/logdna/tail-file-node/commit/2f02a9f39f)] - fix: Invalid README link, and add code coverage badge (Darin Spivey)

# 2020-10-14, Version 1.0.0 (Stable)

* [[2824c145f6](https://github.com/logdna/tail-file-node/commit/2824c145f6)] - **(SEMVER-MAJOR)** package: tail-file.js lib code and tests (Darin Spivey) [LOG-7520](https://logdna.atlassian.net/browse/LOG-7520)
