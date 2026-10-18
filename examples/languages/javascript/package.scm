(use-modules (guix packages) (guix gexp) (guix utils)
             (guix build-system gnu) ((guix licenses) #:prefix license:)
             (gnu packages))

(define runtime (specification->package "node"))

(package
  (name "workbench-javascript-reference")
  (version "0.1.0")
  (source (local-file "." "javascript-reference-source" #:recursive? #t
                        #:select? (lambda (file stat)
                                    (not (member (basename file)
                                                 '(".git" "node_modules" "build" "dist" "coverage"
                                                   ".venv" "__pycache__" "target"))))))
  (build-system gnu-build-system)
  (arguments
   (list #:phases
         #~(modify-phases %standard-phases
             (delete 'configure)
             (replace 'build (lambda _ #t))
             (replace 'check (lambda _
             (invoke "node" "--input-type=module" "-e"
                     "import assert from 'node:assert/strict'; const m=await import('./src/arithmetic.js'); assert.equal(m.sum([20,22]),42); assert.equal(m.countByte(new TextEncoder().encode('banana'),97),3); assert.throws(()=>m.countByte(new Uint8Array(),256),RangeError);")))
             (replace 'install (lambda _
               (let ((destination (string-append #$output "/share/nodejs/workbench-javascript-reference")))
                 (mkdir-p (string-append destination "/build"))
                 (copy-recursively "src" (string-append destination "/build/src"))
                 (copy-file "package.json" (string-append destination "/package.json"))))))))
  (native-inputs (map specification->package '()))
  (propagated-inputs (list runtime))
  (synopsis "Workbench javascript reference")
  (description "An independently packaged Workbench language example.")
  (home-page "https://github.com/greghogan/workbench")
  (license license:asl2.0))
