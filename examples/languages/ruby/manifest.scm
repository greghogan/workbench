;; The project lock owns Bundler and gems; the environment owns Ruby and native extension prerequisites.
(specifications->manifest
 '("bash" "coreutils" "git" "ruby@4.0" "node" "nss-certs" "gcc-toolchain" "make" "pkg-config" "openssl" "libyaml"))
