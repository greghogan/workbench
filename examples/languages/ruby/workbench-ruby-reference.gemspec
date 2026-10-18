# frozen_string_literal: true

Gem::Specification.new do |spec|
  spec.name = "workbench-ruby-reference"
  spec.version = "0.1.0"
  spec.summary = "A strict, portable Workbench Ruby reference"
  spec.authors = ["Workbench contributors"]
  spec.license = "Apache-2.0"
  spec.homepage = "https://github.com/workbench/workbench"
  spec.required_ruby_version = ">= 3.3.12"
  spec.files = Dir["lib/**/*.rb", "sig/**/*.rbs", "bin/*", "README.md", "LICENSE"]
  spec.bindir = "bin"
  spec.executables = ["count"]
  spec.require_paths = ["lib"]
  spec.metadata["rubygems_mfa_required"] = "true"
end
