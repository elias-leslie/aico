# Releasing A-Term

A-Term uses GitHub Releases as the canonical public release-notes surface.

Rules:
- Public releases use semantic-version tags only: `vX.Y.Z`
- Do not push checkpoint, snapshot, or other internal tags to `origin`
- The release workflow creates the GitHub Release automatically when a semver tag is pushed

Release steps:
1. Make sure `main` is clean and pushed.
2. Pick the next semantic version.
3. Create an annotated tag:
   `git tag -a vX.Y.Z -m "vX.Y.Z"`
4. Push the tag:
   `git push origin vX.Y.Z`
5. Confirm the GitHub Actions `release` workflow creates the Release entry.
6. Review the generated release notes and tighten the wording if needed.

Notes:
- The GitHub Release page is the public changelog.
- If release notes need manual cleanup, edit the GitHub Release body rather than creating a second changelog file with duplicate content.
