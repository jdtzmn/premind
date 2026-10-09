# Protocol v1 fixtures

These files preserve raw daemon result payloads from released protocol-v1 shapes.
They are immutable compatibility inputs, not snapshots to regenerate from current
schemas.

| Fixture | Source commit | Contract boundary |
| --- | --- | --- |
| `a75d55f-pre-host-debug-status.json` | `a75d55ff01b416ebe903dd859bd9035f39b30325` | Last `debugStatus` shape before session `host` became required |
| `e43cba0-pre-bundle-pending-reminder.json` | `e43cba064530e457ba2d1de7229c556d1e5a8c58` | Last single pending-reminder result before bundle operations |
| `9e84f2d-first-bundle-claim.json` | `9e84f2dfd96dc900f88584b696a8c4e8aa0c7d6c` | First bundle claim result without a handoff token |
| `0a309df-tokenized-bundle-claim.json` | `0a309dfebd7447403a89173ebb7046234261a0c4` | First tokenized bundle claim result |
