# 固定 G2P 模型

上游：[Kyubyong/g2p](https://github.com/Kyubyong/g2p)，发布包 [g2p_en 2.1.0](https://pypi.org/project/g2p-en/2.1.0/)，Apache-2.0。

- wheel SHA-256：`2a7aabf1fc7f270fcc3349881407988c9245173c2413debbe5432f4a4f31319f`
- `checkpoint20.npz` SHA-256：`b8af35e4596d8dd5836dfd3fe9b2ba4f97b9c311efe8879544cbcfcbd566d8c6`
- `inference.py` 保留上游 NumPy 神经网络推理，移除 NLTK、下载、分词、POS 和内部词典依赖；加入解码未终止时的失败检查。不是规则式 G2P。
- 已验证环境：Python 3.9、NumPy 1.26.4。完整许可在 `THIRD_PARTY_LICENSES/G2P-EN-LICENSE.txt`。

模型仅在本地显式运行 `npm run build:g2p` 时使用。普通网站构建不运行模型、不包含模型权重和私人预测文件。输入规范化、组合词拆分和输出验证由 `scripts/build-g2p-data.py` 完成，流水线版本为 `g2p-private-v1`。组合词不模拟连读；预测不是词典核验结果。
