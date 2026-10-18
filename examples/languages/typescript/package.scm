(use-modules (guix packages) (guix gexp) (guix utils)
             (guix build-system gnu) ((guix licenses) #:prefix license:)
             (gnu packages))

(define runtime (specification->package "node"))

(package
  (name "workbench-typescript-reference")
  (version "0.1.0")
  (source (local-file "." "typescript-reference-source" #:recursive? #t
                        #:select? (lambda (file stat)
                                    (not (member (basename file)
                                                 '(".git" "node_modules" "build" "dist" "coverage"
                                                   ".venv" "__pycache__" "target"))))))
  (build-system gnu-build-system)
  (arguments
   (list #:phases
         #~(modify-phases %standard-phases
             (delete 'configure)
             (replace 'build (lambda _
             (invoke "node" "-e"
                     "const f=require('node:fs'); const c=JSON.parse(f.readFileSync('tsconfig.json')); c.compilerOptions.types=[]; c.compilerOptions.outDir='build'; c.include=['src/**/*.ts']; f.writeFileSync('tsconfig.managed.json',JSON.stringify(c));")
             (invoke "tsc" "--project" "tsconfig.managed.json")))
             (replace 'check (lambda _
             (invoke "node" "--input-type=module" "-e"
                     "import assert from 'node:assert/strict'; const m=await import('./build/src/arithmetic.js'); assert.equal(m.sum([20,22]),42); assert.equal(m.countByte(new TextEncoder().encode('banana'),97),3); assert.throws(()=>m.countByte(new Uint8Array(),256),RangeError);")))
             (replace 'install (lambda _
               (let ((destination (string-append #$output "/share/nodejs/workbench-typescript-reference")))
                 (mkdir-p (string-append destination "/build"))
                 (copy-recursively "build/src" (string-append destination "/build/src"))
                 (copy-file "package.json" (string-append destination "/package.json"))))))))
  (native-inputs (map specification->package '("node-typescript")))
  (propagated-inputs (list runtime))
  (synopsis "Workbench typescript reference")
  (description "An independently packaged Workbench language example.")
  (home-page "https://github.com/greghogan/workbench")
  (license license:asl2.0))
