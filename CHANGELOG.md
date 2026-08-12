## [1.2.7](https://github.com/sapieonic/magick-utils/compare/v1.2.6...v1.2.7) (2026-08-12)


### Bug Fixes

* restore dashboard volume from the campaign list ([#27](https://github.com/sapieonic/magick-utils/issues/27)) ([e07c183](https://github.com/sapieonic/magick-utils/commit/e07c183da5ab72f0e5fbe6974fb08fd08e9cbfaf))

## [1.2.6](https://github.com/sapieonic/magick-utils/compare/v1.2.5...v1.2.6) (2026-08-12)


### Bug Fixes

* unblock analytics ingest stuck on legacy batch locks ([#26](https://github.com/sapieonic/magick-utils/issues/26)) ([fc2a2bd](https://github.com/sapieonic/magick-utils/commit/fc2a2bda951c450c9e5b2bd4c6e3470205485c18)), closes [Pre-#25](https://github.com/Pre-/issues/25)

## [1.2.5](https://github.com/sapieonic/magick-utils/compare/v1.2.4...v1.2.5) (2026-08-12)


### Bug Fixes

* Harden ingestion publication flow ([#25](https://github.com/sapieonic/magick-utils/issues/25)) ([9feace7](https://github.com/sapieonic/magick-utils/commit/9feace7195c2345ae196de24a7357b39bd92bee3))

## [1.2.4](https://github.com/sapieonic/magick-utils/compare/v1.2.3...v1.2.4) (2026-08-12)


### Bug Fixes

* Handle duplicate ingestion record IDs ([#24](https://github.com/sapieonic/magick-utils/issues/24)) ([ab55bdd](https://github.com/sapieonic/magick-utils/commit/ab55bdd6a7909da013e849537d86e54fbd279664))

## [1.2.3](https://github.com/sapieonic/magick-utils/compare/v1.2.2...v1.2.3) (2026-08-11)


### Bug Fixes

* resume jobs after upstream rate limits ([#20](https://github.com/sapieonic/magick-utils/issues/20)) ([be07772](https://github.com/sapieonic/magick-utils/commit/be07772c12222761350d35ceb461871200d050bc))

## [1.2.2](https://github.com/sapieonic/magick-utils/compare/v1.2.1...v1.2.2) (2026-07-15)


### Bug Fixes

* Recover JSON from prose-wrapped LLM output ([#19](https://github.com/sapieonic/magick-utils/issues/19)) ([398816a](https://github.com/sapieonic/magick-utils/commit/398816a045ea930194cf9b5b7332e85a2e27b992))

## [1.2.1](https://github.com/sapieonic/magick-utils/compare/v1.2.0...v1.2.1) (2026-07-03)


### Bug Fixes

* Control insights model from backend ([#18](https://github.com/sapieonic/magick-utils/issues/18)) ([1a3b78f](https://github.com/sapieonic/magick-utils/commit/1a3b78f782c699660bbdeb1931986dfdb91155ed))

# [1.2.0](https://github.com/sapieonic/magick-utils/compare/v1.1.0...v1.2.0) (2026-06-27)


### Features

* add runtime whitelabeling via brand packs (BRAND env) ([#17](https://github.com/sapieonic/magick-utils/issues/17)) ([fd276c6](https://github.com/sapieonic/magick-utils/commit/fd276c6da0129f864855e4591bcf44ae08542bf2))

# [1.1.0](https://github.com/sapieonic/magick-utils/compare/v1.0.0...v1.1.0) (2026-06-27)


### Features

* add Comparative Insights (4a) and Best-Time-to-Reach heatmap (4b) ([#16](https://github.com/sapieonic/magick-utils/issues/16)) ([d561e50](https://github.com/sapieonic/magick-utils/commit/d561e509a63ee057be518d35ecfb9c7a53eaeede))

# 1.0.0 (2026-06-18)


### Bug Fixes

* redirect to login on session expiry (context 401 + app guard) ([#11](https://github.com/sapieonic/magick-utils/issues/11)) ([b519b64](https://github.com/sapieonic/magick-utils/commit/b519b64e9da4e2654eede737ba0498acc9822fb7)), closes [#9](https://github.com/sapieonic/magick-utils/issues/9)


### Features

* log all API requests and outgoing calls to Grafana ([#10](https://github.com/sapieonic/magick-utils/issues/10)) ([2e82c94](https://github.com/sapieonic/magick-utils/commit/2e82c948245dd0581bfba38c279a3350c4f4c4e5))
* MagickUtils analytics app — campaigns, analytics, AI insights, deployment ([#1](https://github.com/sapieonic/magick-utils/issues/1)) ([62c52af](https://github.com/sapieonic/magick-utils/commit/62c52af82531deba13df929f1a11f3de2138066f))
* real user greeting + cascading account picker ([#3](https://github.com/sapieonic/magick-utils/issues/3)) ([5070744](https://github.com/sapieonic/magick-utils/commit/5070744e1c7e02685bc15a62386a1bc66f02a155))
* ship server logs to Grafana via OpenTelemetry ([#8](https://github.com/sapieonic/magick-utils/issues/8)) ([3f92124](https://github.com/sapieonic/magick-utils/commit/3f921245187eba7c2b455eb9bd21529dc6163e5d))
