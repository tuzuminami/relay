# 06. API・イベント・Plugin契約

    ## 1. HTTP API
    | Method | Path | 用途 |
|---|---|---|
| `POST` | `/v1/chat/completions` | 統一Chat API |
| `POST` | `/v1/embeddings` | 統一Embeddings API |
| `GET` | `/v1/routes/resolve` | Route解決のdry-run |
| `GET` | `/v1/usage` | 利用状況の検索 |
| `POST` | `/v1/providers/validate` | Provider設定検証 |

    ## 2. 共通Request Header
    | Header | 必須 | 用途 |
    |---|---|---|
    | `Authorization` | Yes | Bearer tokenまたはサービス認証 |
    | `X-Tenant-Id` | Yes | tenant context |
    | `X-Correlation-Id` | Recommended | 分散トレース・監査 |
    | `Idempotency-Key` | 変更系でRecommended | 再送による重複防止 |

    ## 3. 共通Response Envelope
    ```json
    {
      "data": {},
      "meta": {
        "requestId": "req_...",
        "correlationId": "corr_...",
        "apiVersion": "v1"
      }
    }
    ```

    ## 4. エラー形式
    ```json
    {
      "error": {
        "code": "TENANT_SCOPE_DENIED",
        "message": "Request cannot access this resource.",
        "details": [],
        "correlationId": "corr_..."
      }
    }
    ```

    ## 5. Plugin SPI
    ```ts
    export interface Plugin {
      readonly name: string;
      readonly version: string;
      readonly capabilities: readonly string[];
      healthCheck(context: PluginContext): Promise<PluginHealth>;
      shutdown?(): Promise<void>;
    }
    ```

    ### Plugin制約
    - Pluginはtenant contextを明示引数として受け取る。
    - PluginにSecret値を引き渡さず、短命credentialまたはSecretReferenceを利用する。
    - timeout、retry、fallbackはHost側が制御し、Plugin実装へ丸投げしない。
    - 互換性は`coreApiVersion`で検証し、不一致時は起動を失敗させる。

    ## 6. イベント規約
    ```json
    {
      "eventId": "evt_...",
      "eventType": "relay.resource.changed.v1",
      "occurredAt": "2026-07-04T00:00:00Z",
      "tenantId": "ten_...",
      "correlationId": "corr_...",
      "payload": {}
    }
    ```
    イベントpayloadにSecret、完全な会話本文、不要な直接識別子を含めない。
