/**
 * Composition root — Node, exporting the capability shape the app is written
 * against.
 *
 * The entrypoint imports this and hands the result to `createApp`. A test can
 * build the same object without starting a server.
 */

export { createNodeRuntime, createNodeRequestHandler, fatalProblems as nodeFatalProblems } from './node'
export type { NodeRuntime } from './node'
export { fatalProblems, resolveDeployment } from './deployment'
export type { DeploymentResolution } from './deployment'
export { nullAnalytics, deliveryAnalyticsForwarder } from './analytics'
export { nodeBackground, nodeExecutionContext } from './background'
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
