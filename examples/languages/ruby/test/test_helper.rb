# frozen_string_literal: true

require_relative "coverage_helper" if ENV["WORKBENCH_COVERAGE"] == "true"

require "minitest/autorun"
require "workbench_ruby_reference"

Minitest.parallel_executor = Minitest::Parallel::Executor.new(Integer(ENV.fetch("WORKBENCH_JOB_CPUS", "1"), 10))
