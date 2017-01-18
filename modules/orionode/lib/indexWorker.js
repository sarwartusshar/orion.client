/*******************************************************************************
 * Copyright (c) 2015 IBM Corporation and others.
 * All rights reserved. This program and the accompanying materials are made 
 * available under the terms of the Eclipse Public License v1.0 
 * (http://www.eclipse.org/legal/epl-v10.html), and the Eclipse Distribution 
 * License v1.0 (http://www.eclipse.org/org/documents/edl-v10.html). 
 *
 * Contributors:
 *     IBM Corporation - initial API and implementation
 *******************************************************************************/
/*eslint-env node*/
try {
	var Promise = require('bluebird');
	var path = require('path');
	var originalFs = require('fs');
	var fs = Promise.promisifyAll(require('fs'));
	var elasticlunr = require('elasticlunr');
	var os = require('os');
	var SUBDIR_SEARCH_CONCURRENCY = 10;
	var DEBUG = false;
	var indexWorkspaceDir;
	var excludeNames = {};
	var isIndexOfCurrentWorkSpaceExist = true;
	var stopCurrentIndexing = false;
	var lastIsUsingIndexState;
	var lastExcludeNames = [];
	var INDEX_USE_WORKERS = true; // Need to change the same flag in search.js to debug without worker.
	/**
	 * updating logic:
	 * Add new: (updateIndexEntry)
	 * 	file: add one index
	 *  folder: do nothing
	 * Rename: (updateIndexEntry)
	 *  postpone whole index until all subsequent rename requests all done.
	 * Delete: (indexAfterAllDone)
	 *  postpone whole index until all subsequent delete requests all done
	 * Drag and drop files or folder: (indexAfterAllDone)
	 *  postpone whole index until all subsequent files drag in requests all done
	 * Git Page Related operations,apply patch,rebase..: (indexAfterAllDone)
	 *  postpone whole index until all subsequent git operations requests all done
	 */
	var Indexer = function (indexDir) {
		this.LONG_WAITING = 1000;
		this.SHORT_WAITING = 500;
		this.updateIndexEntry = function (updatePackage, userworkspaceDir, userID) {
			var oldfilePath = updatePackage.location && updatePackage.location.substring(6);
			var newFilePath = updatePackage.filepath;
			var fileName = updatePackage.name;
			if(oldfilePath){
				// Rename operation
				this.indexAfterAllDone(Indexer.SHORT_WAITING, userworkspaceDir, userID);
			}else if(newFilePath){
				addOneNewIndex(newFilePath,fileName, userworkspaceDir, indexDir, userID);
			}
		}.bind(this);
		this.indexAfterAllDone = function(interval, userworkspaceDir, userID){
			if (this.doIndexTimeout) {
				clearTimeout(this.doIndexTimeout);
			}
			this.doIndexTimeout = setTimeout(function() {
				indexing(userworkspaceDir, indexDir, userID);
				this.doIndexTimeout = null;
			}.bind(this), interval);
		};
		this.doIndex = function(userworkspaceDir, userID){
			return indexing(userworkspaceDir, indexDir, userID);
		};
	};

	var getIndexer = function (indexDir) {
		return new Indexer(indexDir);
	};

	function initIndex() {
		return elasticlunr(function () {
			this.addField('Name');
			this.setRef("id");
			this.pipeline.reset();
			var trimmer = function (token) {
				if (token === null || token === undefined) {
					throw new Error('token should not be undefined');
				}
				return token
					.replace(/^\s+/, '')
					.replace(/\s+$/, '');
			};
			trimmer.label = "trimmer";
			this.pipeline.add(trimmer);
		});
	}

	function makedocs(workspaceDir, dirLocation, filename, refId, index) {
		if(stopCurrentIndexing){
			return;
		}
		if(excludeNames[filename]) {
			return;
		}
		var filePath = path.join(dirLocation, filename);
		return fs.statAsync(filePath)
			.then(function (stats) {
				/*eslint consistent-return:0*/
				if (stats.isDirectory()) {
					if (filename[0] === ".") {
						// do not search hidden dirs like .git
						return;
					}
					if (filePath.substring(filePath.length - 1) !== "/") filePath = filePath + "/";
					return fs.readdirAsync(filePath)
						.then(function (directoryFiles) {
							return Promise.map(directoryFiles, function (entry) {
								return makedocs(workspaceDir, filePath, entry, refId, index);
							}, {
									concurrency: SUBDIR_SEARCH_CONCURRENCY
								});
						});
				}
				var filePathFromWorkspace = filePath.substring(workspaceDir.length);
				index.addDoc({
					"Name": filename,
					"Path": filePathFromWorkspace.substring(1),
					"id": refId.id++
				});
			}).catch(function(err){
			});
	}


	function indexing(workspaceDir, indexDir, userId) {
		var refId = {
			id: 0
		};
		var index = initIndex();
		var targetWorkspaceDir = indexWorkspaceDir ? indexWorkspaceDir : workspaceDir; // This is to handle a special case in electron, when user switch work spaces.
		return fs.readdirAsync(targetWorkspaceDir)
			.then(function (children) {
				DEBUG && console.log("indexing workspace: ",targetWorkspaceDir);
				DEBUG && console.time("indexing");
				return Promise.map(children, function (child) {
					return makedocs(targetWorkspaceDir, targetWorkspaceDir, child, refId, index);
				}, {
						concurrency: SUBDIR_SEARCH_CONCURRENCY
					});
			}).then(function () {
				DEBUG && console.timeEnd("indexing");
				var savingOperation;
				if(indexWorkspaceDir){
					if(indexWorkspaceDir === targetWorkspaceDir){
						// In case the last index of old workspace hasn't finished, but the target is already a new workspace
						savingOperation =  saveIndexToFile(index, indexDir, userId);
					}
				}else{
					savingOperation =  saveIndexToFile(index, indexDir, userId);
				}
				return savingOperation;
			}).catch(function(err){
			});
	}

	function saveIndexToFile(index, indexDir, userId) {
		var that = this;
		return new Promise(function (fulfill, reject) {
			originalFs.writeFile(path.join(indexDir,userId)+".json", JSON.stringify(index), function (err) {
				if (err) {
					reject(err);
				}
				DEBUG && console.log("index saved");
				if(!isIndexOfCurrentWorkSpaceExist){
					isIndexOfCurrentWorkSpaceExist = true;
					if(INDEX_USE_WORKERS){
						that.postMessage({
							isIndexOfCurrentWorkSpaceExist: isIndexOfCurrentWorkSpaceExist,
						});
					}else{
						require("./search").updateIsIndexOfCurrentWorkSpaceExist(isIndexOfCurrentWorkSpaceExist);
					}
				}
				fulfill(index);
			});
		});
	}
	
	function addOneNewIndex(newFilePath,fileName, workspaceDir, indexDir, userId) {
		return fs.statAsync(newFilePath)
		.then(function (stats) {
			if (!stats.isDirectory()) {
				var index = initIndex();
				return fs.readFileAsync(path.join(indexDir,userId)+".json", "utf8").then(function (file) {
					return index = elasticlunr.Index.load(JSON.parse(file));
				}).catch(function(){
					return;
				}).then(function () {
					var filePathFromWorkspace = newFilePath.substring(workspaceDir.length);
					var newIndexEntry = {
						"Name": fileName,
						"Path": filePathFromWorkspace.substring(1),
						"id":  index.documentStore.length
					};
					index.addDoc(newIndexEntry);
				}).then(function(){
					return saveIndexToFile(index, indexDir, userId);
				});
			}
		});
	}

	var scheduleIndex = function (workspaceDir, interval, indexDir, userId) {
		return Promise.resolve(workspaceDir).then(function (workspaceDir) {
			return readPrefsFile(interval)
				.then(function (excludeNamesArray) {
					excludeNames = {};
					excludeNamesArray.forEach(function(name) {
						excludeNames[name] = true;
					});
					return indexing(workspaceDir, indexDir, userId)
						.then(function () {
							return scheduleIndex(workspaceDir, interval, indexDir, userId);
						}).catch(function () {
							return scheduleIndex(workspaceDir, interval, indexDir, userId);
						});
				});
		});
	};
	function readPrefsFile(interval) {
		try {
			var content = fs.readFileSync(path.join(os.homedir(), '.orion', 'prefs.json'),'utf8');
			var preferrence = JSON.parse(content);
		} catch (e) {}
		var generalSetting = preferrence && preferrence.user && preferrence.user.general;
		var usingIndex = generalSetting && generalSetting.settings && generalSetting.settings.generalSettings && generalSetting.settings.generalSettings.filenameSearchPolicy || false;
		var excludeNamesArray = generalSetting && generalSetting.settings && generalSetting.settings.generalSettings && generalSetting.settings.generalSettings.indexExcludeFileNames || ["node_modules"];
		if(usingIndex !== lastIsUsingIndexState || excludeNamesArray.length !== lastExcludeNames.length || !excludeNamesArray.every(function(v,i) { return v === lastExcludeNames[i];})){
			// If any index file search setting changed, we assume the index file is not ready for use.
			isIndexOfCurrentWorkSpaceExist = false;
			if(INDEX_USE_WORKERS){
				this.postMessage({
					isIndexOfCurrentWorkSpaceExist: isIndexOfCurrentWorkSpaceExist,
				});
			}else{
				require("./search").updateIsIndexOfCurrentWorkSpaceExist(isIndexOfCurrentWorkSpaceExist);
			}
			lastIsUsingIndexState = usingIndex;
			lastExcludeNames = excludeNamesArray;
		}
		if(usingIndex){
			return new Promise(function (fulfill) {
				setTimeout(function () {
					return fulfill(excludeNamesArray);
				}, interval);
			});
		}
		return Promise.resolve(interval).then(function (interval) {
			return waitForAWhile(interval)
				.then(function () {
					return readPrefsFile(interval);
				});
		});
	}
	
	function waitForAWhile(interval){
		return new Promise(function (fulfill) {
			setTimeout(function () {
				return fulfill();
			}, interval);
		});
	}
	
	var handleWorkspaceDirChanged = function(workspaceDir){
		stopCurrentIndexing = true;
		isIndexOfCurrentWorkSpaceExist = false;
		indexWorkspaceDir = workspaceDir;
		setTimeout(function() {
			// After most of the makedocs method returns(because they are still inding the old workspace)
			stopCurrentIndexing = false;
		}, 500);
	};
	
	if (typeof module !== "undefined") {
		module.exports.scheduleIndex = scheduleIndex;
		module.exports.getIndexer = getIndexer;
		module.exports.handleWorkspaceDirChanged = handleWorkspaceDirChanged;
	}

	this.onmessage = function (event) {
		switch(event.data.type){
			case "startIndex":
				this.scheduleIndex(event.data.workspaceDir, event.data.inverval, event.data.indexDir, event.data.userId);
				break;
			
			case "workspaceDirChange":
				this.handleWorkspaceDirChanged(event.data.workspaceDir);	
				break;
		}	
	}.bind(this);
}catch (err){
	console.log(err.message);
}