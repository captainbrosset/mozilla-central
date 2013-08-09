/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cr = Components.results;

Components.utils.import("resource://gre/modules/XPCOMUtils.jsm");
Components.utils.import("resource://gre/modules/Services.jsm");

XPCOMUtils.defineLazyModuleGetter(this, "AddonRepository",
                                  "resource://gre/modules/AddonRepository.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "FileUtils",
                                  "resource://gre/modules/FileUtils.jsm");


["LOG", "WARN", "ERROR"].forEach(function(aName) {
  Object.defineProperty(this, aName, {
    get: function logFuncGetter () {
      Components.utils.import("resource://gre/modules/AddonLogging.jsm");

      LogManager.getLogger("addons.xpi-utils", this);
      return this[aName];
    },
    configurable: true
  });
}, this);


const KEY_PROFILEDIR                  = "ProfD";
const FILE_DATABASE                   = "extensions.sqlite";
const FILE_JSON_DB                    = "extensions.json";
const FILE_OLD_DATABASE               = "extensions.rdf";
const FILE_XPI_ADDONS_LIST            = "extensions.ini";

// The value for this is in Makefile.in
#expand const DB_SCHEMA                       = __MOZ_EXTENSIONS_DB_SCHEMA__;

const PREF_DB_SCHEMA                  = "extensions.databaseSchema";
const PREF_PENDING_OPERATIONS         = "extensions.pendingOperations";
const PREF_EM_ENABLED_ADDONS          = "extensions.enabledAddons";
const PREF_EM_DSS_ENABLED             = "extensions.dss.enabled";


// Properties that only exist in the database
const DB_METADATA        = ["syncGUID",
                            "installDate",
                            "updateDate",
                            "size",
                            "sourceURI",
                            "releaseNotesURI",
                            "applyBackgroundUpdates"];
const DB_BOOL_METADATA   = ["visible", "active", "userDisabled", "appDisabled",
                            "pendingUninstall", "bootstrap", "skinnable",
                            "softDisabled", "isForeignInstall",
                            "hasBinaryComponents", "strictCompatibility"];

const FIELDS_ADDON = "internal_id, id, syncGUID, location, version, type, " +
                     "internalName, updateURL, updateKey, optionsURL, " +
                     "optionsType, aboutURL, iconURL, icon64URL, " +
                     "defaultLocale, visible, active, userDisabled, " +
                     "appDisabled, pendingUninstall, descriptor, " +
                     "installDate, updateDate, applyBackgroundUpdates, bootstrap, " +
                     "skinnable, size, sourceURI, releaseNotesURI, softDisabled, " +
                     "isForeignInstall, hasBinaryComponents, strictCompatibility";


// Properties that exist in the install manifest
const PROP_METADATA      = ["id", "version", "type", "internalName", "updateURL",
                            "updateKey", "optionsURL", "optionsType", "aboutURL",
                            "iconURL", "icon64URL"];
const PROP_LOCALE_SINGLE = ["name", "description", "creator", "homepageURL"];
const PROP_LOCALE_MULTI  = ["developers", "translators", "contributors"];
const PROP_TARGETAPP     = ["id", "minVersion", "maxVersion"];

// Properties to save in JSON file
const PROP_JSON_FIELDS = ["id", "syncGUID", "location", "version", "type",
                          "internalName", "updateURL", "updateKey", "optionsURL",
                          "optionsType", "aboutURL", "iconURL", "icon64URL",
                          "defaultLocale", "visible", "active", "userDisabled",
                          "appDisabled", "pendingUninstall", "descriptor", "installDate",
                          "updateDate", "applyBackgroundUpdates", "bootstrap",
                          "skinnable", "size", "sourceURI", "releaseNotesURI",
                          "softDisabled", "foreignInstall", "hasBinaryComponents",
                          "strictCompatibility", "locales", "targetApplications",
                          "targetPlatforms"];


const PREFIX_ITEM_URI                 = "urn:mozilla:item:";
const RDFURI_ITEM_ROOT                = "urn:mozilla:item:root"
const PREFIX_NS_EM                    = "http://www.mozilla.org/2004/em-rdf#";

Object.defineProperty(this, "gRDF", {
  get: function gRDFGetter() {
    delete this.gRDF;
    return this.gRDF = Cc["@mozilla.org/rdf/rdf-service;1"].
                       getService(Ci.nsIRDFService);
  },
  configurable: true
});

function EM_R(aProperty) {
  return gRDF.GetResource(PREFIX_NS_EM + aProperty);
}

/**
 * Converts an RDF literal, resource or integer into a string.
 *
 * @param  aLiteral
 *         The RDF object to convert
 * @return a string if the object could be converted or null
 */
function getRDFValue(aLiteral) {
  if (aLiteral instanceof Ci.nsIRDFLiteral)
    return aLiteral.Value;
  if (aLiteral instanceof Ci.nsIRDFResource)
    return aLiteral.Value;
  if (aLiteral instanceof Ci.nsIRDFInt)
    return aLiteral.Value;
  return null;
}

/**
 * Gets an RDF property as a string
 *
 * @param  aDs
 *         The RDF datasource to read the property from
 * @param  aResource
 *         The RDF resource to read the property from
 * @param  aProperty
 *         The property to read
 * @return a string if the property existed or null
 */
function getRDFProperty(aDs, aResource, aProperty) {
  return getRDFValue(aDs.GetTarget(aResource, EM_R(aProperty), true));
}


/**
 * A mozIStorageStatementCallback that will asynchronously build DBAddonInternal
 * instances from the results it receives. Once the statement has completed
 * executing and all of the metadata for all of the add-ons has been retrieved
 * they will be passed as an array to aCallback.
 *
 * @param  aCallback
 *         A callback function to pass the array of DBAddonInternals to
 */
function AsyncAddonListCallback(aCallback) {
  this.callback = aCallback;
  this.addons = [];
}

AsyncAddonListCallback.prototype = {
  callback: null,
  complete: false,
  count: 0,
  addons: null,

  handleResult: function AsyncAddonListCallback_handleResult(aResults) {
    let row = null;
    while ((row = aResults.getNextRow())) {
      this.count++;
      let self = this;
      XPIDatabase.makeAddonFromRowAsync(row, function handleResult_makeAddonFromRowAsync(aAddon) {
        function completeAddon(aRepositoryAddon) {
          aAddon._repositoryAddon = aRepositoryAddon;
          aAddon.compatibilityOverrides = aRepositoryAddon ?
                                            aRepositoryAddon.compatibilityOverrides :
                                            null;
          self.addons.push(aAddon);
          if (self.complete && self.addons.length == self.count)
           self.callback(self.addons);
        }

        if ("getCachedAddonByID" in AddonRepository)
          AddonRepository.getCachedAddonByID(aAddon.id, completeAddon);
        else
          completeAddon(null);
      });
    }
  },

  handleError: asyncErrorLogger,

  handleCompletion: function AsyncAddonListCallback_handleCompletion(aReason) {
    this.complete = true;
    if (this.addons.length == this.count)
      this.callback(this.addons);
  }
};

/**
 * Asynchronously fill in the _repositoryAddon field for one addon
 */
function getRepositoryAddon(aAddon, aCallback) {
  if (!aAddon) {
    aCallback(aAddon);
    return;
  }
  function completeAddon(aRepositoryAddon) {
    aAddon._repositoryAddon = aRepositoryAddon;
    aAddon.compatibilityOverrides = aRepositoryAddon ?
                                      aRepositoryAddon.compatibilityOverrides :
                                      null;
    aCallback(aAddon);
  }
  AddonRepository.getCachedAddonByID(aAddon.id, completeAddon);
}

/**
 * A helper method to asynchronously call a function on an array
 * of objects, calling a callback when function(x) has been gathered
 * for every element of the array.
 * WARNING: not currently error-safe; if the async function does not call
 * our internal callback for any of the array elements, asyncMap will not
 * call the callback parameter.
 *
 * @param  aObjects
 *         The array of objects to process asynchronously
 * @param  aMethod
 *         Function with signature function(object, function aCallback(f_of_object))
 * @param  aCallback
 *         Function with signature f([aMethod(object)]), called when all values
 *         are available
 */
function asyncMap(aObjects, aMethod, aCallback) {
  var resultsPending = aObjects.length;
  var results = []
  if (resultsPending == 0) {
    aCallback(results);
    return;
  }

  function asyncMap_gotValue(aIndex, aValue) {
    results[aIndex] = aValue;
    if (--resultsPending == 0) {
      aCallback(results);
    }
  }

  aObjects.map(function asyncMap_each(aObject, aIndex, aArray) {
    try {
      aMethod(aObject, function asyncMap_callback(aResult) {
        asyncMap_gotValue(aIndex, aResult);
      });
    }
    catch (e) {
      WARN("Async map function failed", e);
      asyncMap_gotValue(aIndex, undefined);
    }
  });
}

/**
 * A generator to synchronously return result rows from an mozIStorageStatement.
 *
 * @param  aStatement
 *         The statement to execute
 */
function resultRows(aStatement) {
  try {
    while (stepStatement(aStatement))
      yield aStatement.row;
  }
  finally {
    aStatement.reset();
  }
}


/**
 * A helper function to log an SQL error.
 *
 * @param  aError
 *         The storage error code associated with the error
 * @param  aErrorString
 *         An error message
 */
function logSQLError(aError, aErrorString) {
  ERROR("SQL error " + aError + ": " + aErrorString);
}

/**
 * A helper function to log any errors that occur during async statements.
 *
 * @param  aError
 *         A mozIStorageError to log
 */
function asyncErrorLogger(aError) {
  logSQLError(aError.result, aError.message);
}

/**
 * A helper function to execute a statement synchronously and log any error
 * that occurs.
 *
 * @param  aStatement
 *         A mozIStorageStatement to execute
 */
function executeStatement(aStatement) {
  try {
    aStatement.execute();
  }
  catch (e) {
    logSQLError(XPIDatabase.connection.lastError,
                XPIDatabase.connection.lastErrorString);
    throw e;
  }
}

/**
 * A helper function to step a statement synchronously and log any error that
 * occurs.
 *
 * @param  aStatement
 *         A mozIStorageStatement to execute
 */
function stepStatement(aStatement) {
  try {
    return aStatement.executeStep();
  }
  catch (e) {
    logSQLError(XPIDatabase.connection.lastError,
                XPIDatabase.connection.lastErrorString);
    throw e;
  }
}


/**
 * Copies properties from one object to another. If no target object is passed
 * a new object will be created and returned.
 *
 * @param  aObject
 *         An object to copy from
 * @param  aProperties
 *         An array of properties to be copied
 * @param  aTarget
 *         An optional target object to copy the properties to
 * @return the object that the properties were copied onto
 */
function copyProperties(aObject, aProperties, aTarget) {
  if (!aTarget)
    aTarget = {};
  aProperties.forEach(function(aProp) {
    aTarget[aProp] = aObject[aProp];
  });
  return aTarget;
}

/**
 * Copies properties from a mozIStorageRow to an object. If no target object is
 * passed a new object will be created and returned.
 *
 * @param  aRow
 *         A mozIStorageRow to copy from
 * @param  aProperties
 *         An array of properties to be copied
 * @param  aTarget
 *         An optional target object to copy the properties to
 * @return the object that the properties were copied onto
 */
function copyRowProperties(aRow, aProperties, aTarget) {
  if (!aTarget)
    aTarget = {};
  aProperties.forEach(function(aProp) {
    aTarget[aProp] = aRow.getResultByName(aProp);
  });
  return aTarget;
}

/**
 * Create a DBAddonInternal from the fields saved in the JSON database
 * or loaded into an AddonInternal from an XPI manifest.
 * @return a DBAddonInternal populated with the loaded data
 */

/**
 * The DBAddonInternal is a special AddonInternal that has been retrieved from
 * the database. The constructor will initialize the DBAddonInternal with a set
 * of fields, which could come from either the JSON store or as an
 * XPIProvider.AddonInternal created from an addon's manifest
 * @constructor
 * @param aLoaded
 *        Addon data fields loaded from JSON or the addon manifest.
 */
function DBAddonInternal(aLoaded) {
  copyProperties(aLoaded, PROP_JSON_FIELDS, this);
  if (aLoaded._installLocation) {
    this._installLocation = aLoaded._installLocation;
    this.location = aLoaded._installLocation._name;
  }
  else if (aLoaded.location) {
    this._installLocation = XPIProvider.installLocationsByName[this.location];
  }
  this._key = this.location + ":" + this.id;
  try {
    this._sourceBundle = this._installLocation.getLocationForID(this.id);
  }
  catch (e) {
    // An exception will be thrown if the add-on appears in the database but
    // not on disk. In general this should only happen during startup as
    // this change is being detected.
  }

  Object.defineProperty(this, "pendingUpgrade", {
    get: function DBA_pendingUpgradeGetter() {
      delete this.pendingUpgrade;
      for (let install of XPIProvider.installs) {
        if (install.state == AddonManager.STATE_INSTALLED &&
            !(install.addon.inDatabase) &&
            install.addon.id == this.id &&
            install.installLocation == this._installLocation) {
          return this.pendingUpgrade = install.addon;
        }
      };
    },
    configurable: true
  });
}

DBAddonInternal.prototype = {
  applyCompatibilityUpdate: function DBA_applyCompatibilityUpdate(aUpdate, aSyncCompatibility) {
    XPIDatabase.beginTransaction();
    this.targetApplications.forEach(function(aTargetApp) {
      aUpdate.targetApplications.forEach(function(aUpdateTarget) {
        if (aTargetApp.id == aUpdateTarget.id && (aSyncCompatibility ||
            Services.vc.compare(aTargetApp.maxVersion, aUpdateTarget.maxVersion) < 0)) {
          aTargetApp.minVersion = aUpdateTarget.minVersion;
          aTargetApp.maxVersion = aUpdateTarget.maxVersion;
        }
      });
    });
    XPIProvider.updateAddonDisabledState(this);
    XPIDatabase.commitTransaction();
  },
  get inDatabase() {
    return true;
  }
}

DBAddonInternal.prototype.__proto__ = AddonInternal.prototype;

this.XPIDatabase = {
  // true if the database connection has been opened
  initialized: false,
  // A cache of statements that are used and need to be finalized on shutdown
  statementCache: {},
  // A cache of weak referenced DBAddonInternals so we can reuse objects where
  // possible
  addonCache: [],
  // The nested transaction count
  transactionCount: 0,
  // The database file
  dbfile: FileUtils.getFile(KEY_PROFILEDIR, [FILE_DATABASE], true),
  jsonFile: FileUtils.getFile(KEY_PROFILEDIR, [FILE_JSON_DB], true),
  // Migration data loaded from an old version of the database.
  migrateData: null,
  // Active add-on directories loaded from extensions.ini and prefs at startup.
  activeBundles: null,

  // The statements used by the database
  statements: {
    _getDefaultLocale: "SELECT id, name, description, creator, homepageURL " +
                       "FROM locale WHERE id=:id",
    _getLocales: "SELECT addon_locale.locale, locale.id, locale.name, " +
                 "locale.description, locale.creator, locale.homepageURL " +
                 "FROM addon_locale JOIN locale ON " +
                 "addon_locale.locale_id=locale.id WHERE " +
                 "addon_internal_id=:internal_id",
    _getTargetApplications: "SELECT addon_internal_id, id, minVersion, " +
                            "maxVersion FROM targetApplication WHERE " +
                            "addon_internal_id=:internal_id",
    _getTargetPlatforms: "SELECT os, abi FROM targetPlatform WHERE " +
                         "addon_internal_id=:internal_id",
    _readLocaleStrings: "SELECT locale_id, type, value FROM locale_strings " +
                        "WHERE locale_id=:id",

    clearVisibleAddons: "UPDATE addon SET visible=0 WHERE id=:id",
    updateAddonActive: "UPDATE addon SET active=:active WHERE " +
                       "internal_id=:internal_id",

    getActiveAddons: "SELECT " + FIELDS_ADDON + " FROM addon WHERE active=1 AND " +
                     "type<>'theme' AND bootstrap=0",
    getActiveTheme: "SELECT " + FIELDS_ADDON + " FROM addon WHERE " +
                    "internalName=:internalName AND type='theme'",
    getThemes: "SELECT " + FIELDS_ADDON + " FROM addon WHERE type='theme'",

    getAddonInLocation: "SELECT " + FIELDS_ADDON + " FROM addon WHERE id=:id " +
                        "AND location=:location",
    getAddons: "SELECT " + FIELDS_ADDON + " FROM addon",
    getAddonsByType: "SELECT " + FIELDS_ADDON + " FROM addon WHERE type=:type",
    getAddonsInLocation: "SELECT " + FIELDS_ADDON + " FROM addon WHERE " +
                         "location=:location",
    getInstallLocations: "SELECT DISTINCT location FROM addon",
    getVisibleAddonForID: "SELECT " + FIELDS_ADDON + " FROM addon WHERE " +
                          "visible=1 AND id=:id",
    getVisibleAddonForInternalName: "SELECT " + FIELDS_ADDON + " FROM addon " +
                                    "WHERE visible=1 AND internalName=:internalName",
    getVisibleAddons: "SELECT " + FIELDS_ADDON + " FROM addon WHERE visible=1",
    getVisibleAddonsWithPendingOperations: "SELECT " + FIELDS_ADDON + " FROM " +
                                           "addon WHERE visible=1 " +
                                           "AND (pendingUninstall=1 OR " +
                                           "MAX(userDisabled,appDisabled)=active)",
    getAddonBySyncGUID: "SELECT " + FIELDS_ADDON + " FROM addon " +
                        "WHERE syncGUID=:syncGUID",
    makeAddonVisible: "UPDATE addon SET visible=1 WHERE internal_id=:internal_id",
    removeAddonMetadata: "DELETE FROM addon WHERE internal_id=:internal_id",
    // Equates to active = visible && !userDisabled && !softDisabled &&
    //                     !appDisabled && !pendingUninstall
    setActiveAddons: "UPDATE addon SET active=MIN(visible, 1 - userDisabled, " +
                     "1 - softDisabled, 1 - appDisabled, 1 - pendingUninstall)",
    setAddonProperties: "UPDATE addon SET userDisabled=:userDisabled, " +
                        "appDisabled=:appDisabled, " +
                        "softDisabled=:softDisabled, " +
                        "pendingUninstall=:pendingUninstall, " +
                        "applyBackgroundUpdates=:applyBackgroundUpdates WHERE " +
                        "internal_id=:internal_id",
    setAddonDescriptor: "UPDATE addon SET descriptor=:descriptor WHERE " +
                        "internal_id=:internal_id",
    setAddonSyncGUID: "UPDATE addon SET syncGUID=:syncGUID WHERE " +
                      "internal_id=:internal_id",
    updateTargetApplications: "UPDATE targetApplication SET " +
                              "minVersion=:minVersion, maxVersion=:maxVersion " +
                              "WHERE addon_internal_id=:internal_id AND id=:id",

    createSavepoint: "SAVEPOINT 'default'",
    releaseSavepoint: "RELEASE SAVEPOINT 'default'",
    rollbackSavepoint: "ROLLBACK TO SAVEPOINT 'default'"
  },

  get dbfileExists() {
    delete this.dbfileExists;
    return this.dbfileExists = this.dbfile.exists();
  },
  set dbfileExists(aValue) {
    delete this.dbfileExists;
    return this.dbfileExists = aValue;
  },

  /**
   * Converts the current internal state of the XPI addon database to JSON
   * and writes it to the user's profile. Synchronous for now, eventually must
   * be async, reliable, etc.
   */
  writeJSON: function XPIDB_writeJSON() {
    // XXX should have a guard here for if the addonDB hasn't been auto-loaded yet
    let addons = [];
    for (let aKey in this.addonDB) {
      addons.push(copyProperties(this.addonDB[aKey], PROP_JSON_FIELDS));
    }
    let toSave = {
      schemaVersion: DB_SCHEMA,
      addons: addons
    };

    let stream = FileUtils.openSafeFileOutputStream(this.jsonFile);
    let converter = Cc["@mozilla.org/intl/converter-output-stream;1"].
      createInstance(Ci.nsIConverterOutputStream);
    try {
      converter.init(stream, "UTF-8", 0, 0x0000);
      // XXX pretty print the JSON while debugging
      converter.writeString(JSON.stringify(toSave, null, 2));
      converter.flush();
      // nsConverterOutputStream doesn't finish() safe output streams on close()
      FileUtils.closeSafeFileOutputStream(stream);
      converter.close();
    }
    catch(e) {
      ERROR("Failed to save database to JSON", e);
      stream.close();
    }
  },

  /**
   * Open and parse the JSON XPI extensions database.
   * @return true: the DB was successfully loaded
   *         false: The DB either needs upgrade or did not exist at all.
   *         XXX upgrade and errors handled in a following patch
   */
  openJSONDatabase: function XPIDB_openJSONDatabase() {
    dump("XPIDB_openJSONDatabase\n");
    try {
      let data = "";
      let fstream = Components.classes["@mozilla.org/network/file-input-stream;1"].
              createInstance(Components.interfaces.nsIFileInputStream);
      let cstream = Components.classes["@mozilla.org/intl/converter-input-stream;1"].
              createInstance(Components.interfaces.nsIConverterInputStream);
      fstream.init(this.jsonFile, -1, 0, 0);
      cstream.init(fstream, "UTF-8", 0, 0);
      let (str = {}) {
        let read = 0;
        do {
          read = cstream.readString(0xffffffff, str); // read as much as we can and put it in str.value
          data += str.value;
        } while (read != 0);
      }
      cstream.close();
      let inputAddons = JSON.parse(data);
      // Now do some sanity checks on our JSON db
      if (!("schemaVersion" in inputAddons) || !("addons" in inputAddons)) {
        // XXX Content of JSON file is bad, need to rebuild from scratch
        ERROR("bad JSON file contents");
        delete this.addonDB;
        this.addonDB = {};
        return false;
      }
      if (inputAddons.schemaVersion != DB_SCHEMA) {
        // XXX UPGRADE FROM PREVIOUS VERSION OF JSON DB
        ERROR("JSON schema upgrade needed");
        return false;
      }
      // If we got here, we probably have good data
      // Make AddonInternal instances from the loaded data and save them
      delete this.addonDB;
      let addonDB = {}
      inputAddons.addons.forEach(function(loadedAddon) {
        let newAddon = new DBAddonInternal(loadedAddon);
        addonDB[newAddon._key] = newAddon;
      });
      this.addonDB = addonDB;
      // dump("Finished reading DB: " + this.addonDB.toSource() + "\n");
      return true;
    }
    catch(e) {
      // XXX handle missing JSON database
      ERROR("Failed to load XPI JSON data from profile", e);
      // XXX for now, start from scratch
      delete this.addonDB;
      this.addonDB = {};
      return false;
    }
  },

  /**
   * Begins a new transaction in the database. Transactions may be nested. Data
   * written by an inner transaction may be rolled back on its own. Rolling back
   * an outer transaction will rollback all the changes made by inner
   * transactions even if they were committed. No data is written to the disk
   * until the outermost transaction is committed. Transactions can be started
   * even when the database is not yet open in which case they will be started
   * when the database is first opened.
   */
  beginTransaction: function XPIDB_beginTransaction() {
    this.transactionCount++;
  },

  /**
   * Commits the most recent transaction. The data may still be rolled back if
   * an outer transaction is rolled back.
   */
  commitTransaction: function XPIDB_commitTransaction() {
    if (this.transactionCount == 0) {
      ERROR("Attempt to commit one transaction too many.");
      return;
    }

    this.transactionCount--;

    if (this.transactionCount == 0) {
      // All our nested transactions are done, write the JSON file
      this.writeJSON();
    }
  },

  /**
   * Rolls back the most recent transaction. The database will return to its
   * state when the transaction was started.
   */
  rollbackTransaction: function XPIDB_rollbackTransaction() {
    if (this.transactionCount == 0) {
      ERROR("Attempt to rollback one transaction too many.");
      return;
    }

    this.transactionCount--;
    // XXX IRVING we don't handle rollback in the JSON store
  },

  /**
   * Attempts to open the database file. If it fails it will try to delete the
   * existing file and create an empty database. If that fails then it will
   * open an in-memory database that can be used during this session.
   *
   * @param  aDBFile
   *         The nsIFile to open
   * @return the mozIStorageConnection for the database
   */
  openDatabaseFile: function XPIDB_openDatabaseFile(aDBFile) {
    LOG("Opening database");
    let connection = null;

    // Attempt to open the database
    try {
      connection = Services.storage.openUnsharedDatabase(aDBFile);
      this.dbfileExists = true;
    }
    catch (e) {
      ERROR("Failed to open database (1st attempt)", e);
      // If the database was locked for some reason then assume it still
      // has some good data and we should try to load it the next time around.
      if (e.result != Cr.NS_ERROR_STORAGE_BUSY) {
        try {
          aDBFile.remove(true);
        }
        catch (e) {
          ERROR("Failed to remove database that could not be opened", e);
        }
        try {
          connection = Services.storage.openUnsharedDatabase(aDBFile);
        }
        catch (e) {
          ERROR("Failed to open database (2nd attempt)", e);

          // If we have got here there seems to be no way to open the real
          // database, instead open a temporary memory database so things will
          // work for this session.
          return Services.storage.openSpecialDatabase("memory");
        }
      }
      else {
        return Services.storage.openSpecialDatabase("memory");
      }
    }

    connection.executeSimpleSQL("PRAGMA synchronous = FULL");
    connection.executeSimpleSQL("PRAGMA locking_mode = EXCLUSIVE");

    return connection;
  },

  /**
   * Opens a new connection to the database file.
   *
   * @param  aRebuildOnError
   *         A boolean indicating whether add-on information should be loaded
   *         from the install locations if the database needs to be rebuilt.
   */
  openConnection: function XPIDB_openConnection(aRebuildOnError, aForceOpen) {
    this.openJSONDatabase();
    this.initialized = true;
    return;
    // XXX IRVING deal with the migration logic below and in openDatabaseFile...

    delete this.connection;

    if (!aForceOpen && !this.dbfileExists) {
      this.connection = null;
      return;
    }

    this.migrateData = null;

    this.connection = this.openDatabaseFile(this.dbfile);

    // If the database was corrupt or missing then the new blank database will
    // have a schema version of 0.
    let schemaVersion = this.connection.schemaVersion;
    if (schemaVersion != DB_SCHEMA) {
      // A non-zero schema version means that a schema has been successfully
      // created in the database in the past so we might be able to get useful
      // information from it
      if (schemaVersion != 0) {
        LOG("Migrating data from schema " + schemaVersion);
        this.migrateData = this.getMigrateDataFromDatabase();

        // Delete the existing database
        this.connection.close();
        try {
          if (this.dbfileExists)
            this.dbfile.remove(true);

          // Reopen an empty database
          this.connection = this.openDatabaseFile(this.dbfile);
        }
        catch (e) {
          ERROR("Failed to remove old database", e);
          // If the file couldn't be deleted then fall back to an in-memory
          // database
          this.connection = Services.storage.openSpecialDatabase("memory");
        }
      }
      else {
        let dbSchema = 0;
        try {
          dbSchema = Services.prefs.getIntPref(PREF_DB_SCHEMA);
        } catch (e) {}

        if (dbSchema == 0) {
          // Only migrate data from the RDF if we haven't done it before
          this.migrateData = this.getMigrateDataFromRDF();
        }
      }

      // At this point the database should be completely empty
      try {
        this.createSchema();
      }
      catch (e) {
        // If creating the schema fails, then the database is unusable,
        // fall back to an in-memory database.
        this.connection = Services.storage.openSpecialDatabase("memory");
      }

      // If there is no migration data then load the list of add-on directories
      // that were active during the last run
      if (!this.migrateData)
        this.activeBundles = this.getActiveBundles();

      if (aRebuildOnError) {
        WARN("Rebuilding add-ons database from installed extensions.");
        this.beginTransaction();
        try {
          let state = XPIProvider.getInstallLocationStates();
          XPIProvider.processFileChanges(state, {}, false);
          // Make sure to update the active add-ons and add-ons list on shutdown
          Services.prefs.setBoolPref(PREF_PENDING_OPERATIONS, true);
          this.commitTransaction();
        }
        catch (e) {
          ERROR("Error processing file changes", e);
          this.rollbackTransaction();
        }
      }
    }

    // If the database connection has a file open then it has the right schema
    // by now so make sure the preferences reflect that.
    if (this.connection.databaseFile) {
      Services.prefs.setIntPref(PREF_DB_SCHEMA, DB_SCHEMA);
      Services.prefs.savePrefFile(null);
    }

    // Begin any pending transactions
    for (let i = 0; i < this.transactionCount; i++)
      this.connection.executeSimpleSQL("SAVEPOINT 'default'");
  },

  /**
   * Lazy getter for the addons database
   */
  get addonDB() {
    delete this.addonDB;
    this.openJSONDatabase();
    return this.addonDB;
  },

  /**
   * Gets the list of file descriptors of active extension directories or XPI
   * files from the add-ons list. This must be loaded from disk since the
   * directory service gives no easy way to get both directly. This list doesn't
   * include themes as preferences already say which theme is currently active
   *
   * @return an array of persisitent descriptors for the directories
   */
  getActiveBundles: function XPIDB_getActiveBundles() {
    let bundles = [];

    let addonsList = FileUtils.getFile(KEY_PROFILEDIR, [FILE_XPI_ADDONS_LIST],
                                       true);

    if (!addonsList.exists())
      return null;

    try {
      let iniFactory = Cc["@mozilla.org/xpcom/ini-parser-factory;1"]
                         .getService(Ci.nsIINIParserFactory);
      let parser = iniFactory.createINIParser(addonsList);
      let keys = parser.getKeys("ExtensionDirs");

      while (keys.hasMore())
        bundles.push(parser.getString("ExtensionDirs", keys.getNext()));
    }
    catch (e) {
      WARN("Failed to parse extensions.ini", e);
      return null;
    }

    // Also include the list of active bootstrapped extensions
    for (let id in XPIProvider.bootstrappedAddons)
      bundles.push(XPIProvider.bootstrappedAddons[id].descriptor);

    return bundles;
  },

  /**
   * Retrieves migration data from the old extensions.rdf database.
   *
   * @return an object holding information about what add-ons were previously
   *         userDisabled and any updated compatibility information
   */
  getMigrateDataFromRDF: function XPIDB_getMigrateDataFromRDF(aDbWasMissing) {

    // Migrate data from extensions.rdf
    let rdffile = FileUtils.getFile(KEY_PROFILEDIR, [FILE_OLD_DATABASE], true);
    if (!rdffile.exists())
      return null;

    LOG("Migrating data from " + FILE_OLD_DATABASE);
    let migrateData = {};

    try {
      let ds = gRDF.GetDataSourceBlocking(Services.io.newFileURI(rdffile).spec);
      let root = Cc["@mozilla.org/rdf/container;1"].
                 createInstance(Ci.nsIRDFContainer);
      root.Init(ds, gRDF.GetResource(RDFURI_ITEM_ROOT));
      let elements = root.GetElements();

      while (elements.hasMoreElements()) {
        let source = elements.getNext().QueryInterface(Ci.nsIRDFResource);

        let location = getRDFProperty(ds, source, "installLocation");
        if (location) {
          if (!(location in migrateData))
            migrateData[location] = {};
          let id = source.ValueUTF8.substring(PREFIX_ITEM_URI.length);
          migrateData[location][id] = {
            version: getRDFProperty(ds, source, "version"),
            userDisabled: false,
            targetApplications: []
          }

          let disabled = getRDFProperty(ds, source, "userDisabled");
          if (disabled == "true" || disabled == "needs-disable")
            migrateData[location][id].userDisabled = true;

          let targetApps = ds.GetTargets(source, EM_R("targetApplication"),
                                         true);
          while (targetApps.hasMoreElements()) {
            let targetApp = targetApps.getNext()
                                      .QueryInterface(Ci.nsIRDFResource);
            let appInfo = {
              id: getRDFProperty(ds, targetApp, "id")
            };

            let minVersion = getRDFProperty(ds, targetApp, "updatedMinVersion");
            if (minVersion) {
              appInfo.minVersion = minVersion;
              appInfo.maxVersion = getRDFProperty(ds, targetApp, "updatedMaxVersion");
            }
            else {
              appInfo.minVersion = getRDFProperty(ds, targetApp, "minVersion");
              appInfo.maxVersion = getRDFProperty(ds, targetApp, "maxVersion");
            }
            migrateData[location][id].targetApplications.push(appInfo);
          }
        }
      }
    }
    catch (e) {
      WARN("Error reading " + FILE_OLD_DATABASE, e);
      migrateData = null;
    }

    return migrateData;
  },

  /**
   * Retrieves migration data from a database that has an older or newer schema.
   *
   * @return an object holding information about what add-ons were previously
   *         userDisabled and any updated compatibility information
   */
  getMigrateDataFromDatabase: function XPIDB_getMigrateDataFromDatabase() {
    let migrateData = {};

    // Attempt to migrate data from a different (even future!) version of the
    // database
    try {
      var stmt = this.connection.createStatement("PRAGMA table_info(addon)");

      const REQUIRED = ["internal_id", "id", "location", "userDisabled",
                        "installDate", "version"];

      let reqCount = 0;
      let props = [];
      for (let row in resultRows(stmt)) {
        if (REQUIRED.indexOf(row.name) != -1) {
          reqCount++;
          props.push(row.name);
        }
        else if (DB_METADATA.indexOf(row.name) != -1) {
          props.push(row.name);
        }
        else if (DB_BOOL_METADATA.indexOf(row.name) != -1) {
          props.push(row.name);
        }
      }

      if (reqCount < REQUIRED.length) {
        ERROR("Unable to read anything useful from the database");
        return null;
      }
      stmt.finalize();

      stmt = this.connection.createStatement("SELECT " + props.join(",") + " FROM addon");
      for (let row in resultRows(stmt)) {
        if (!(row.location in migrateData))
          migrateData[row.location] = {};
        let addonData = {
          targetApplications: []
        }
        migrateData[row.location][row.id] = addonData;

        props.forEach(function(aProp) {
          if (aProp == "isForeignInstall")
            addonData.foreignInstall = (row[aProp] == 1);
          if (DB_BOOL_METADATA.indexOf(aProp) != -1)
            addonData[aProp] = row[aProp] == 1;
          else
            addonData[aProp] = row[aProp];
        })
      }

      var taStmt = this.connection.createStatement("SELECT id, minVersion, " +
                                                   "maxVersion FROM " +
                                                   "targetApplication WHERE " +
                                                   "addon_internal_id=:internal_id");

      for (let location in migrateData) {
        for (let id in migrateData[location]) {
          taStmt.params.internal_id = migrateData[location][id].internal_id;
          delete migrateData[location][id].internal_id;
          for (let row in resultRows(taStmt)) {
            migrateData[location][id].targetApplications.push({
              id: row.id,
              minVersion: row.minVersion,
              maxVersion: row.maxVersion
            });
          }
        }
      }
    }
    catch (e) {
      // An error here means the schema is too different to read
      ERROR("Error migrating data", e);
      return null;
    }
    finally {
      if (taStmt)
        taStmt.finalize();
      if (stmt)
        stmt.finalize();
    }

    return migrateData;
  },

  /**
   * Shuts down the database connection and releases all cached objects.
   */
  shutdown: function XPIDB_shutdown(aCallback) {
    LOG("shutdown");
    if (this.initialized) {
      if (this.transactionCount > 0) {
        ERROR(this.transactionCount + " outstanding transactions, rolling back.");
        while (this.transactionCount > 0)
          this.rollbackTransaction();
      }

      // If we are running with an in-memory database then force a new
      // extensions.ini to be written to disk on the next startup
      // XXX IRVING special case for if we fail to save extensions.json?
      // XXX maybe doesn't need to be at shutdown?
      // if (!this.connection.databaseFile)
      //   Services.prefs.setBoolPref(PREF_PENDING_OPERATIONS, true);

      this.initialized = false;

      // Clear out the cached addons data loaded from JSON and recreate
      // the getter to allow database re-loads during testing.
      delete this.addonDB;
      Object.defineProperty(this, "addonDB", {
        get: function addonsGetter() {
          this.openJSONDatabase();
          return this.addonDB;
        },
        configurable: true
      });
      // XXX IRVING removed an async callback when the database was closed
      // XXX do we want to keep the ability to async flush extensions.json
      // XXX and then call back?
      if (aCallback)
        aCallback();
    }
    else {
      if (aCallback)
        aCallback();
    }
  },

  /**
   * Return a list of all install locations known about by the database. This
   * is often a a subset of the total install locations when not all have
   * installed add-ons, occasionally a superset when an install location no
   * longer exists.
   *
   * @return  an array of names of install locations
   */
  getInstallLocations: function XPIDB_getInstallLocations() {
    if (!this.addonDB)
      return [];

    let locations = {};
    for each (let addon in this.addonDB) {
      locations[addon.location] = 1;
    }
    return Object.keys(locations);
  },

  /**
   * List all addons that match the filter function
   * @param  aFilter
   *         Function that takes an addon instance and returns
   *         true if that addon should be included in the selected array
   * @return an array of DBAddonInternals
   */
  _listAddons: function XPIDB_listAddons(aFilter) {
    if (!this.addonDB)
      return [];

    let addonList = [];
    for (let key in this.addonDB) {
      let addon = this.addonDB[key];
      if (aFilter(addon)) {
        addonList.push(addon);
      }
    }

    return addonList;
  },

  /**
   * Find the first addon that matches the filter function
   * @param  aFilter
   *         Function that takes an addon instance and returns
   *         true if that addon should be selected
   * @return The first DBAddonInternal for which the filter returns true
   */
  _findAddon: function XPIDB_findAddon(aFilter) {
    if (!this.addonDB)
      return null;

    for (let key in this.addonDB) {
      let addon = this.addonDB[key];
      if (aFilter(addon)) {
        return addon;
      }
    }

    return null;
  },

  /**
   * Synchronously reads all the add-ons in a particular install location.
   *
   * @param  aLocation
   *         The name of the install location
   * @return an array of DBAddonInternals
   */
  getAddonsInLocation: function XPIDB_getAddonsInLocation(aLocation) {
    return this._listAddons(function inLocation(aAddon) {return (aAddon.location == aLocation);});
  },

  /**
   * Asynchronously gets an add-on with a particular ID in a particular
   * install location.
   * XXX IRVING sync for now
   *
   * @param  aId
   *         The ID of the add-on to retrieve
   * @param  aLocation
   *         The name of the install location
   * @param  aCallback
   *         A callback to pass the DBAddonInternal to
   */
  getAddonInLocation: function XPIDB_getAddonInLocation(aId, aLocation, aCallback) {
    getRepositoryAddon(this.addonDB[aLocation + ":" + aId], aCallback);
  },

  /**
   * Asynchronously gets the add-on with an ID that is visible.
   * XXX IRVING sync
   *
   * @param  aId
   *         The ID of the add-on to retrieve
   * @param  aCallback
   *         A callback to pass the DBAddonInternal to
   */
  getVisibleAddonForID: function XPIDB_getVisibleAddonForID(aId, aCallback) {
    let addon = this._findAddon(function visibleID(aAddon) {return ((aAddon.id == aId) && aAddon.visible)});
    getRepositoryAddon(addon, aCallback);
  },

  /**
   * Asynchronously gets the visible add-ons, optionally restricting by type.
   * XXX IRVING sync
   *
   * @param  aTypes
   *         An array of types to include or null to include all types
   * @param  aCallback
   *         A callback to pass the array of DBAddonInternals to
   */
  getVisibleAddons: function XPIDB_getVisibleAddons(aTypes, aCallback) {
    let addons = this._listAddons(function visibleType(aAddon) {
      return (aAddon.visible && (!aTypes || (aTypes.length == 0) || (aTypes.indexOf(aAddon.type) > -1)))
    });
    asyncMap(addons, getRepositoryAddon, aCallback);
  },

  /**
   * Synchronously gets all add-ons of a particular type.
   *
   * @param  aType
   *         The type of add-on to retrieve
   * @return an array of DBAddonInternals
   */
  getAddonsByType: function XPIDB_getAddonsByType(aType) {
    return this._listAddons(function byType(aAddon) { return aAddon.type == aType; });
  },

  /**
   * Synchronously gets an add-on with a particular internalName.
   *
   * @param  aInternalName
   *         The internalName of the add-on to retrieve
   * @return a DBAddonInternal
   */
  getVisibleAddonForInternalName: function XPIDB_getVisibleAddonForInternalName(aInternalName) {
    return this._findAddon(function visibleInternalName(aAddon) {
      return (aAddon.visible && (aAddon.internalName == aInternalName));
    });
  },

  /**
   * Asynchronously gets all add-ons with pending operations.
   * XXX IRVING sync
   *
   * @param  aTypes
   *         The types of add-ons to retrieve or null to get all types
   * @param  aCallback
   *         A callback to pass the array of DBAddonInternal to
   */
  getVisibleAddonsWithPendingOperations:
    function XPIDB_getVisibleAddonsWithPendingOperations(aTypes, aCallback) {

    let addons = this._listAddons(function visibleType(aAddon) {
      return (aAddon.visible &&
        (aAddon.pendingUninstall ||
         // Logic here is tricky. If we're active but either
         // disabled flag is set, we're pending disable; if we're not
         // active and neither disabled flag is set, we're pending enable
         (aAddon.active == (aAddon.userDisabled || aAddon.appDisabled))) &&
        (!aTypes || (aTypes.length == 0) || (aTypes.indexOf(aAddon.type) > -1)))
    });
    asyncMap(addons, getRepositoryAddon, aCallback);
  },

  /**
   * Asynchronously get an add-on by its Sync GUID.
   * XXX IRVING sync
   *
   * @param  aGUID
   *         Sync GUID of add-on to fetch
   * @param  aCallback
   *         A callback to pass the DBAddonInternal record to. Receives null
   *         if no add-on with that GUID is found.
   *
   */
  getAddonBySyncGUID: function XPIDB_getAddonBySyncGUID(aGUID, aCallback) {
    let addon = this._findAddon(function bySyncGUID(aAddon) { return aAddon.syncGUID == aGUID; });
    getRepositoryAddon(addon, aCallback);
  },

  /**
   * Synchronously gets all add-ons in the database.
   *
   * @return  an array of DBAddonInternals
   */
  getAddons: function XPIDB_getAddons() {
    return this._listAddons(function(aAddon) {return true;});
  },

  /**
   * Synchronously adds an AddonInternal's metadata to the database.
   *
   * @param  aAddon
   *         AddonInternal to add
   * @param  aDescriptor
   *         The file descriptor of the add-on
   * @return The DBAddonInternal that was added to the database
   */
  addAddonMetadata: function XPIDB_addAddonMetadata(aAddon, aDescriptor) {
    // If there is no DB yet then forcibly create one
    // XXX IRVING I don't think this will work as expected because the addonDB
    // getter will kick in. Might not matter because of the way the new DB
    // creates itself.
    if (!this.addonDB)
      this.openConnection(false, true);

    this.beginTransaction();

    let newAddon = new DBAddonInternal(aAddon);
    newAddon.descriptor = aDescriptor;
    this.addonDB[newAddon._key] = newAddon;
    if (newAddon.visible) {
      this.makeAddonVisible(newAddon);
    }

    this.commitTransaction();
    return newAddon;
  },

  /**
   * Synchronously updates an add-ons metadata in the database. Currently just
   * removes and recreates.
   *
   * @param  aOldAddon
   *         The DBAddonInternal to be replaced
   * @param  aNewAddon
   *         The new AddonInternal to add
   * @param  aDescriptor
   *         The file descriptor of the add-on
   * @return The DBAddonInternal that was added to the database
   */
  updateAddonMetadata: function XPIDB_updateAddonMetadata(aOldAddon, aNewAddon,
                                                          aDescriptor) {
    this.beginTransaction();

    // Any errors in here should rollback the transaction
    try {
      this.removeAddonMetadata(aOldAddon);
      aNewAddon.syncGUID = aOldAddon.syncGUID;
      aNewAddon.installDate = aOldAddon.installDate;
      aNewAddon.applyBackgroundUpdates = aOldAddon.applyBackgroundUpdates;
      aNewAddon.foreignInstall = aOldAddon.foreignInstall;
      aNewAddon.active = (aNewAddon.visible && !aNewAddon.userDisabled &&
                          !aNewAddon.appDisabled && !aNewAddon.pendingUninstall)

      let newDBAddon = this.addAddonMetadata(aNewAddon, aDescriptor);
      this.commitTransaction();
      return newDBAddon;
    }
    catch (e) {
      this.rollbackTransaction();
      throw e;
    }
  },

  /**
   * Synchronously removes an add-on from the database.
   *
   * @param  aAddon
   *         The DBAddonInternal being removed
   */
  removeAddonMetadata: function XPIDB_removeAddonMetadata(aAddon) {
    this.beginTransaction();
    delete this.addonDB[aAddon._key];
    this.commitTransaction();
  },

  /**
   * Synchronously marks a DBAddonInternal as visible marking all other
   * instances with the same ID as not visible.
   *
   * @param  aAddon
   *         The DBAddonInternal to make visible
   * @param  callback
   *         A callback to pass the DBAddonInternal to
   */
  makeAddonVisible: function XPIDB_makeAddonVisible(aAddon) {
    this.beginTransaction();
    LOG("Make addon " + aAddon._key + " visible");
    for (let key in this.addonDB) {
      let otherAddon = this.addonDB[key];
      if ((otherAddon.id == aAddon.id) && (otherAddon._key != aAddon._key)) {
        LOG("Hide addon " + otherAddon._key);
        otherAddon.visible = false;
      }
    }
    aAddon.visible = true;
    this.commitTransaction();
  },

  /**
   * Synchronously sets properties for an add-on.
   *
   * @param  aAddon
   *         The DBAddonInternal being updated
   * @param  aProperties
   *         A dictionary of properties to set
   */
  setAddonProperties: function XPIDB_setAddonProperties(aAddon, aProperties) {
    this.beginTransaction();
    for (let key in aProperties) {
      aAddon[key] = aProperties[key];
    }
    this.commitTransaction();
  },

  /**
   * Synchronously sets the Sync GUID for an add-on.
   *
   * @param  aAddon
   *         The DBAddonInternal being updated
   * @param  aGUID
   *         GUID string to set the value to
   * @throws if another addon already has the specified GUID
   */
  setAddonSyncGUID: function XPIDB_setAddonSyncGUID(aAddon, aGUID) {
    // Need to make sure no other addon has this GUID
    function excludeSyncGUID(otherAddon) {
      return (otherAddon._key != aAddon._key) && (otherAddon.syncGUID == aGUID);
    }
    let otherAddon = this._findAddon(excludeSyncGUID);
    if (otherAddon) {
      throw new Error("Addon sync GUID conflict for addon " + aAddon._key +
          ": " + otherAddon._key + " already has GUID " + aGUID);
    }
    this.beginTransaction();
    aAddon.syncGUID = aGUID;
    this.commitTransaction();
  },

  /**
   * Synchronously sets the file descriptor for an add-on.
   * XXX IRVING could replace this with setAddonProperties
   *
   * @param  aAddon
   *         The DBAddonInternal being updated
   * @param  aDescriptor
   *         File path of the installed addon
   */
  setAddonDescriptor: function XPIDB_setAddonDescriptor(aAddon, aDescriptor) {
    this.beginTransaction();
    aAddon.descriptor = aDescriptor;
    this.commitTransaction();
  },

  /**
   * Synchronously updates an add-on's active flag in the database.
   *
   * @param  aAddon
   *         The DBAddonInternal to update
   */
  updateAddonActive: function XPIDB_updateAddonActive(aAddon, aActive) {
    LOG("Updating active state for add-on " + aAddon.id + " to " + aActive);

    this.beginTransaction();
    aAddon.active = aActive;
    this.commitTransaction();
  },

  /**
   * Synchronously calculates and updates all the active flags in the database.
   */
  updateActiveAddons: function XPIDB_updateActiveAddons() {
    // XXX IRVING this may get called during XPI-utils shutdown
    // XXX need to make sure PREF_PENDING_OPERATIONS handling is clean
    LOG("Updating add-on states");
    this.beginTransaction();
    for (let key in this.addonDB) {
      let addon = this.addonDB[key];
      addon.active = (addon.visible && !addon.userDisabled &&
                      !addon.softDisabled && !addon.appDisabled &&
                      !addon.pendingUninstall);
    }
    this.commitTransaction();
  },

  /**
   * Writes out the XPI add-ons list for the platform to read.
   */
  writeAddonsList: function XPIDB_writeAddonsList() {
    Services.appinfo.invalidateCachesOnRestart();

    let addonsList = FileUtils.getFile(KEY_PROFILEDIR, [FILE_XPI_ADDONS_LIST],
                                       true);
    let enabledAddons = [];
    let text = "[ExtensionDirs]\r\n";
    let count = 0;
    let fullCount = 0;

    let activeAddons = this._listAddons(function active(aAddon) {
      return aAddon.active && !aAddon.bootstrap && (aAddon.type != "theme");
    });

    for (let row of activeAddons) {
      text += "Extension" + (count++) + "=" + row.descriptor + "\r\n";
      enabledAddons.push(encodeURIComponent(row.id) + ":" +
                         encodeURIComponent(row.version));
    }
    fullCount += count;

    // The selected skin may come from an inactive theme (the default theme
    // when a lightweight theme is applied for example)
    text += "\r\n[ThemeDirs]\r\n";

    let dssEnabled = false;
    try {
      dssEnabled = Services.prefs.getBoolPref(PREF_EM_DSS_ENABLED);
    } catch (e) {}

    let themes = [];
    if (dssEnabled) {
      themes = this._listAddons(function isTheme(aAddon){ return aAddon.type == "theme"; });
    }
    else {
      let activeTheme = this._findAddon(function isSelected(aAddon) {
        return ((aAddon.type == "theme") && (aAddon.internalName == XPIProvider.selectedSkin));
      });
      if (activeTheme) {
        themes.push(activeTheme);
      }
    }

    if (themes.length > 0) {
      count = 0;
      for (let row of themes) {
        text += "Extension" + (count++) + "=" + row.descriptor + "\r\n";
        enabledAddons.push(encodeURIComponent(row.id) + ":" +
                           encodeURIComponent(row.version));
      }
      fullCount += count;
    }

    if (fullCount > 0) {
      LOG("Writing add-ons list");

      let addonsListTmp = FileUtils.getFile(KEY_PROFILEDIR, [FILE_XPI_ADDONS_LIST + ".tmp"],
                                            true);
      var fos = FileUtils.openFileOutputStream(addonsListTmp);
      fos.write(text, text.length);
      fos.close();
      addonsListTmp.moveTo(addonsListTmp.parent, FILE_XPI_ADDONS_LIST);

      Services.prefs.setCharPref(PREF_EM_ENABLED_ADDONS, enabledAddons.join(","));
    }
    else {
      if (addonsList.exists()) {
        LOG("Deleting add-ons list");
        addonsList.remove(false);
      }

      Services.prefs.clearUserPref(PREF_EM_ENABLED_ADDONS);
    }
  }
};
