# Java resolver signing authorities

`resolver-publishers.asc` contains public certificates for the independently identified release authorities below.
Artifact-scoped rules in `../acquisition.json` select their full fingerprints; possession of a signature or a keyserver
result alone does not establish publisher identity. The maintained Apache certificate for Michael Osipov uses renewed
self-signatures for the same independently established fingerprint.

New inputs require clean current signature evidence. Previously reviewed immutable inputs remain bound to their exact
checksum; reuse does not reinterpret a failed new signature as unavailable authentication. Review new publishers and
certificate changes through the dependency preparation workflow in
[the Java guide](https://github.com/greghogan/workbench/blob/main/docs/java-dependencies.md).

| Primary fingerprint                        | Independent publisher authority                                                                                        |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `0CC641C3A62453AB390066C4A41F13C999945293` | [Apache Commons release keys](https://downloads.apache.org/commons/KEYS)                                               |
| `2DB4F1EF0FA761ECC4EA935C86FDC7E2A11262CB` | [Apache Commons release keys](https://downloads.apache.org/commons/KEYS)                                               |
| `32118CF76C9EC5D918E54967CA80D1F0EB6CA4BA` | [Apache Maven release keys](https://downloads.apache.org/maven/KEYS)                                                   |
| `3690C240CE51B4670D30AD1C38EE757D69184620` | [Tukaani release key](https://tukaani.org/misc/lasse_collin_pubkey.txt)                                                |
| `3F068505A1DF611935F03FB1A1011D0A89C9E497` | [Domtrip release keys](https://github.com/maveniverse/domtrip/blob/993ea899ea344ff037a1dc9fda72e03a13cc4bb5/KEYS)      |
| `475F3B8E59E6E63AA78067482C7B12F2A511E325` | [QOS release keys](https://github.com/qos-ch/reload4j/blob/343b83bc3866daf2e742cc2fd1affc416c6bc880/KEYS)              |
| `6A814B1F869C2BBEAB7CB7271A2A1C94BDE89688` | [Apache Maven release keys](https://downloads.apache.org/maven/KEYS)                                                   |
| `84789D24DF77A32433CE1F079EB80E92EB2135B1` | [Apache Maven release keys](https://downloads.apache.org/maven/KEYS)                                                   |
| `88BE34F94BDB2B5357044E2E3A387D43964143E3` | [Apache Maven release keys](https://downloads.apache.org/maven/KEYS)                                                   |
| `9AC5712CABE9635B65663AB0711C0A9A896FE336` | [Zstd JNI maintainer](https://github.com/luben.gpg)                                                                    |
| `A5BD02B93E7A40482EB1D66A5F69AD087600B22C` | [ASM release key](https://asm.ow2.io/KEY.txt)                                                                          |
| `B02137D875D833D9B23392ECAE5A7FB608A0221C` | [Apache Maven release keys](https://downloads.apache.org/maven/KEYS)                                                   |
| `B6E73D84EA4FCC47166087253FAAD2CD5ECBB314` | [Apache Commons release keys](https://downloads.apache.org/commons/KEYS)                                               |
| `B920D295BF0E61CB4CF0896C33CD6733AF5EC452` | [Apache Maven release keys](https://downloads.apache.org/maven/KEYS)                                                   |
| `BC87A3FD0A54480F0BADBEBD21939FF0CA2A6567` | [Apache Commons release keys](https://downloads.apache.org/commons/KEYS)                                               |
| `BE685132AFD2740D9095F9040CC0B712FEE75827` | [AssertJ maintainer confirmation](https://github.com/assertj/assertj/issues/4467#issuecomment-6615325010)              |
| `CE4439C1BEF3DA83B1832F9DBEFEEF227A98B809` | [Apache Velocity release keys](https://downloads.apache.org/velocity/KEYS)                                             |
| `D196A5E3E70732EEB2E5007F1861C322C56014B2` | [Apache Commons release keys](https://downloads.apache.org/commons/KEYS)                                               |
| `D6F1BC78607808EC8E9F69437A8860944FAD5F62` | [Apache Commons release keys](https://downloads.apache.org/commons/KEYS)                                               |
| `EA23DB1360D9029481E7F2EFECDFEA3CB4493B94` | [Apache Maven release keys](https://downloads.apache.org/maven/KEYS)                                                   |
| `FA77DCFEF2EE6EB2DEBEDD2C012579464D01C06A` | [Apache Maven release keys](https://downloads.apache.org/maven/KEYS)                                                   |
| `FF6E2C001948C5F2F38B0CC385911F425EC61B51` | [JUnit release keys](https://github.com/junit-team/junit-framework/blob/840b69fba7e0ac2f82fe9815bd497c56040be9d9/KEYS) |
