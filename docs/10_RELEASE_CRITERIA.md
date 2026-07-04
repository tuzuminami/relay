# 10. v0.1.0 公開判定基準

## 必須条件
- [ ] READMEに目的、非対象、Quick start、API例、ライセンスがある。
- [ ] `docker compose up`後にE2Eシナリオが通る。
- [ ] 全P0バックログが完了し、各項目が要求IDへ紐づく。
- [ ] tenant越境、認可不足、設定破損、外部Adapter timeoutでfail-openしない。
- [ ] OpenAPI、TypeScript SDK、JSON Schemaのcontract testが通る。
- [ ] DB migrationのupgrade / rollbackまたは復旧方針がテストされている。
- [ ] Secret・PIIを含まないテストfixtureとログマスキングを確認済み。
- [ ] Apache-2.0採用と依存ライセンス監査を完了している。
- [ ] Known limitations、security policy、contributing guide、Code of Conductを追加している。

## 公開を止める条件
- tenant分離の既知バイパスがある。
- 重要操作が監査不能である。
- 依存障害時に安全判断が許可側へ倒れる。
- migrationでデータ消失の可能性が未評価である。
- 互換性破壊が明示されていない。
