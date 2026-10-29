(use-modules (guix packages) (guix download) (guix base16) (gnu packages pretty-print))

;; Match the verified fmt recipe at the project's vcpkg revision, including its upstream fix.
(define fmt-reference
  (package/inherit fmt-12
    (version "12.2.0")
    (source
     (origin
       (method url-fetch)
       (uri "https://github.com/fmtlib/fmt/archive/refs/tags/12.2.0.tar.gz")
       (hash (content-hash
              (base16-string->bytevector "5ac2ba0f54a484999ed5407d82b77aad170cea49a267decd2c0eedadf3b14413e2a83fcc8e9ca9c16640595e019b8636e160f72314d8be50653324e82ac745eb")
              sha512))
       (patches
        (list
         (origin
           (method url-fetch)
           (uri "https://github.com/fmtlib/fmt/commit/588b3a0f8f6a8bcf2a959cae882d5b2703e86737.patch?full_index=1")
           (file-name "fmt-backport-4813.patch")
           (hash (content-hash
                  (base16-string->bytevector "afda8fdfcdcb4b0dd5df4d4dae96a57a85fb9c4b65d0b49d51258f0913d4aed93ed146ebf96ed7b277490b1dde6c7117f43332013071441a96c3147520de8368")
                  sha512)))))))))
