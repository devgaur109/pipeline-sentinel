# Wiring a real CI system

Pipeline Sentinel ingests one normalised shape (`IncomingFailure` in `src/types.ts`).
Provider adapters in `src/lib/webhooks.ts` translate into it.

## GitHub Actions

Two options.

**A. Repository webhook** (no workflow changes). In repo settings → Webhooks:

- Payload URL: `https://<your-worker>.workers.dev/api/ingest`
- Content type: `application/json`
- Secret: the same value as your `WEBHOOK_SECRET`
- Events: *Workflow runs* and *Check runs*

The adapter ignores anything that isn't a completed run with `conclusion: failure`.
Note that this payload does not contain logs — the adapter records what it can and
the log body arrives via option B or the API.

**B. A step in your workflow** (richer, includes the log):

```yaml
      - name: Report failure to Pipeline Sentinel
        if: failure()
        run: |
          LOG=$(tail -c 200000 build.log 2>/dev/null || echo "no log captured")
          jq -n \
            --arg repo "${{ github.repository }}" \
            --arg branch "${{ github.ref_name }}" \
            --arg pipelineId "${{ github.run_id }}" \
            --arg jobName "${{ github.job }}" \
            --arg commitSha "${{ github.sha }}" \
            --arg runUrl "${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}" \
            --arg logText "$LOG" \
            '{provider:"github", repo:$repo, branch:$branch, pipelineId:$pipelineId,
              jobName:$jobName, commitSha:$commitSha, runUrl:$runUrl, logText:$logText}' \
          | curl -sS -X POST "$SENTINEL_URL/api/ingest" \
              -H 'content-type: application/json' \
              -H "x-sentinel-signature: sha256=$(...)" \
              --data-binary @-
        env:
          SENTINEL_URL: ${{ secrets.SENTINEL_URL }}
```

Capture the log with `| tee build.log` on your build step so there is something to send.

## Jenkins

Declarative pipeline post-failure hook:

```groovy
post {
  failure {
    script {
      def log = currentBuild.rawBuild.getLog(2000).join('\n')
      def payload = groovy.json.JsonOutput.toJson([
        provider  : 'jenkins',
        repo      : env.GIT_URL ?: env.JOB_NAME,
        branch    : env.BRANCH_NAME ?: 'unknown',
        pipelineId: env.BUILD_NUMBER,
        jobName   : env.JOB_NAME,
        runUrl    : env.BUILD_URL,
        commitSha : env.GIT_COMMIT,
        logText   : log
      ])
      httpRequest(
        url: "${env.SENTINEL_URL}/api/ingest",
        httpMode: 'POST',
        contentType: 'APPLICATION_JSON',
        requestBody: payload
      )
    }
  }
}
```

`getLog(2000)` caps at the last 2000 lines, which matches what the parser reads anyway.

## Anything else

POST the normalised shape directly:

```bash
curl -X POST "$SENTINEL_URL/api/ingest" \
  -H 'content-type: application/json' \
  -d '{"provider":"manual","repo":"acme/api","branch":"main",
       "pipelineId":"local-1","jobName":"test","logText":"...raw log..."}'
```

## Closing the memory loop

Triage output is only half the system. The corpus improves when a human confirms a
fix worked:

```bash
curl -X POST "$SENTINEL_URL/api/failures/<id>/resolve" \
  -H 'content-type: application/json' \
  -d '{"note":"Bumped node-fetch to 3.3.2; the ESM import was the cause."}'
```

That flips the record to `resolved`, and `searchSimilar()` weights resolved failures
first — so the next matching failure is answered from a confirmed precedent.
