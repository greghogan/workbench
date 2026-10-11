;; Composer locks own tools and dependencies; the environment owns PHP.
(specifications->manifest
 '("bash" "coreutils" "git" "gnupg" "php" "node" "nss-certs" "unzip"))
