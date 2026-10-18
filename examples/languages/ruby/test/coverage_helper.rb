# frozen_string_literal: true

require "json"
require "simplecov"

subprocess = ENV["WORKBENCH_COVERAGE_SUBPROCESS"] == "true"
SimpleCov.start do
  root File.expand_path("..", __dir__)
  enable_coverage :branch
  cover "lib/**/*.rb", "bin/*"
  command_name(subprocess ? "CLI #{Process.pid}" : "Tests")
  if subprocess
    # Each child contributes a partial report; the completed suite enforces the floors.
    formatter false
    print_errors false
  else
    minimum_coverage line: 100, branch: 100
  end
end

unless subprocess
  SimpleCov.at_exit do
    result = SimpleCov.result
    File.write(File.join(SimpleCov.coverage_path, "merged-result.json"), JSON.generate(result.to_hash))
    result.format!
  end
end
