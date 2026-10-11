# frozen_string_literal: true

if ENV["WORKBENCH_COVERAGE"] == "true"
  require "simplecov"
  SimpleCov.start do
    enable_coverage :branch
    track_files "lib/**/*.rb"
    add_filter "/test/"
    minimum_coverage line: 100, branch: 100
  end
end

require "minitest/autorun"
require "workbench_ruby_reference"

Minitest.parallel_executor = Minitest::Parallel::Executor.new(Integer(ENV.fetch("WORKBENCH_JOB_CPUS", "1"), 10))
