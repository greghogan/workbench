const controlled = new Set([
  "MAVEN_ARGS",
  "MAVEN_OPTS",
  "MAVEN_EXT_CLASS_PATH",
  "MAVEN_HOME",
  "M2_HOME",
  "JAVA_TOOL_OPTIONS",
  "JDK_JAVA_OPTIONS",
  "_JAVA_OPTIONS",
  "CLASSPATH",
  "MAVEN_SKIP_RC",
  "MAVEN_BASEDIR",
  "MAVEN_PROJECTBASEDIR",
]);

/** Keep project-owned configuration while excluding inherited JVM and Maven injection. */
export function isolatedMavenEnvironment(
  input: NodeJS.ProcessEnv,
  directory: string,
  options?: string,
): NodeJS.ProcessEnv {
  const env = { ...input };
  for (const name of Object.keys(env)) if (controlled.has(name.toUpperCase())) Reflect.deleteProperty(env, name);
  return {
    ...env,
    MAVEN_SKIP_RC: "1",
    MAVEN_BASEDIR: directory,
    MAVEN_PROJECTBASEDIR: directory,
    ...(options === undefined ? {} : { MAVEN_OPTS: options }),
  };
}
