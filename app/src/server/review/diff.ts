/** The formatted comparison uses source text. Historical file changes can also supply a Git patch for file modes. */
export interface SourceDifference {
  before: string;
  after: string;
  patch?: string;
}
