# Project workflow

The user authorized automatic uploads of future versions on 2026-10-13 (Asia/Taipei): 「之後都自動上傳新版本」.
For user-requested changes in jackyname1/shioaji-codex-trader, complete the implementation, commit and open a PR, run the required Linux and Windows checks including source and packaged GUI validation, then merge and publish a new version when all checks pass. Do not request release permission again unless the user changes this preference or a new action falls outside this project scope.
Never publish failed builds or claim an EXE is available before release assets and their hashes are verified. Preserve user data and keep credentials, certificates, and account records out of commits.
This release authorization covers software delivery; it does not authorize placing live brokerage orders or changing the user's trading permissions.

Before each release, synchronize README version, features, data limits and image links with the delivered app. Replace README screenshots with actual Windows GUI captures of that version, use versioned image filenames, and retain docs/screenshots/provenance.json with the source commit, artifact digest and image hashes. Verify the images and links before merging.
