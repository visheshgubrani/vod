/**
 * Composition roots — one per runtime, exporting the same capability shape.
 *
 * An entrypoint imports exactly one of these and hands the result to
 * `createApp`. A test can build either one, which is what makes the Workers path
 * testable at all: it used to exist only as a side effect of ambient
 * `process.env`.
 */

export { createNodeRuntime, fatalProblems as nodeFatalProblems } from './node'
export type { NodeRuntime } from './node'
export {
  getWorkersRuntime,
  resetWorkersRuntime,
  withRequestContext,
  fatalProblems as workersFatalProblems,
} from './workers'
export type { WorkersIsolateRuntime } from './workers'
export { fatalProblems, resolveDeployment } from './deployment'
export type { DeploymentResolution } from './deployment'
export { stringBindings } from './bindings'
export { nullAnalytics, workersAnalyticsEngine } from './analytics'
export { nodeBackground, workersBackground } from './background'
export type {
  AnalyticsPort,
  AnalyticsReadSource,
  AnalyticsWriteSink,
  BackgroundRun,
  DeploymentProblem,
  DeploymentShape,
  RuntimeDiagnostics,
  DbTransport,
  ModalDispatchTransport,
  PlaybackRow,
  RuntimeCapabilities,
} from './types'
