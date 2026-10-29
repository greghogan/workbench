/** Private tooling entry point, independent of the release packager's runtime surface. */
export { runConsumerIntegration } from "./consumer-integration.js";
export { approveConsumerFixture } from "./consumer-integration-fixtures.js";
export {
  verifyJavaConsumerDistribution,
  verifyJavaWorkspaceConsumerDistribution,
} from "./consumer-integration-java.js";
