```
Pull request format:

This pull request aims to `<(specify reason)>`.


(If updating Dn-help documentation due to a new feature/change)
This pull request corresponds to Dn-Programming-Core-Management/Dn-help#`<PR number>`. Please merge Dn-help's PR before this one.

---

Changes:

- `<Describe change entry>`
	- Fixes/addresses issue `#<issue number>`.

Example

- Fix access violation in MRU submenu list update (@eugene-s-nesdev @Gumball2415 #243 #214)
- Pick song length mode when typing length time in WAV export dialog (@nyanpasu64 #346)

Format

- `<summary> ([issue_author] [commit_author] [#<issue number>] [#<PR number>])`
- only put in issue author and number if it exists
- only put one author if issue and commit author is the same
- sort by category, then by issue number, then by PR number
```

Notice:
- Please fill in the details appropriately.
- Be sure to update desktop/CHANGELOG.md in the `Unreleased` section, as well as the date last updated.
- Check [commit_changelog_format.md](https://github.com/Dn-Programming-Core-Management/Dn-FamiTracker/blob/main/docs/commit_changelog_format.md) for better details on commit and change log style.
