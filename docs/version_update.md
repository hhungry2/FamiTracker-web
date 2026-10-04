# Version Update Checklist

listing out things to do so i won't forget to do them -persune

- [ ] Update changelogs:
	- [CHANGELOG.md](../desktop/CHANGELOG.md), which will update [desktop/Dn-help/hlp/changelog.htm](../desktop/Dn-help/hlp/changelog.htm) upon build
	- see [commit changelog format](commit_changelog_format.md)
- [ ] Update copyright years in:
	- [LICENSE.md](../LICENSE.md)
	- [README.md](../README.md)
	- [Dn-FamiTracker.rc](../desktop/Dn-FamiTracker.rc)
- [ ] Edit every file with version info:`
	- [version.h](../desktop/version.h)
		- [Dn-FamiTracker.rc](../desktop/Dn-FamiTracker.rc) gets its version constants from here through a build script
	- [Readme.txt](../desktop/Readme.txt)
- [ ] **IMPORTANT**: update ConfigVersion.cpp
- [ ] [Dn-help update](../desktop/Dn-help/version_update.md)
- [ ] ***important***: set date of release at the last moment!
- [ ] Create and push Version Tag to the repo
	- Format: `Dnx.y.z.b`
		- x: Major (API change)
		- y: Minor (backward compatible change)
		- z: Patch (backward compatible bugfix)
		- b: Build type (internal, not visible)
			- 0: stable release
			- 9: "dirty"/beta/in-development build
	- Double check that this tag is higher than the previous release tag
	- Version tag's first three digits must be appropriate to Semantic Versioning
	- **include this version's change log in the commit message paragraph**
	- There is a GitHub Actions script to build a drafted release upon a tag push
	- Tag must be on commit deemed appropriate for release
- [ ] Edit and publish the draft release page in GitHub
	- [ ] Triple check that the tag on the release matches the Version Tag (apart from the build type number)
	- [ ] Double check the build artifacts to be accurate and working
- [ ] Notify everyone about the new version
