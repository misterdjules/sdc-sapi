/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/*
 * lib/server/attributes.js: manage attributes on SAPI objects
 *
 * There are four main fields on each SAPI object:
 *
 *  params      Zone parameters used for VMAPI.createVm().
 *
 *  metadata    Key-value pairs used to render configuration files
 *
 *  metadata_schema	An optional schema for a SAPI object.
 *
 *  manifests   A list of configuration manifests.  These along with the
 *          metadata kvpairs will generate a zone's configuration
 *          files.
 */

var assert = require('assert-plus');
var async = require('async');
var restify = require('restify');
var util = require('util');
var vasync = require('vasync');

var sprintf = require('util').format;

var mod_errors = require('./errors');


module.exports = Attributes;

function Attributes(config) {
    assert.object(config, 'config');
    assert.object(config.log, 'config.log');
    assert.object(config.model, 'config.model');

    this.log = config.log;
    this.model = config.model;
}


// -- Functions to manipulate object attributes

var FIELDS = [ 'params', 'metadata', 'manifests', 'metadata_schema' ];

function updateAttributes(obj, changes) {
    assert.object(obj, 'obj');
    assert.object(changes, 'changes');

    FIELDS.forEach(function (field) {
        if (changes[field]) {
            if (!obj[field])
                obj[field] = {};

            Object.keys(changes[field]).forEach(function (key) {
                obj[field][key] = changes[field][key];
            });
        }
    });

    return (obj);
}

function replaceAttributes(obj, changes) {
    assert.object(obj, 'obj');
    assert.object(changes, 'changes');

    FIELDS.forEach(function (field) {
        if (changes[field])
            obj[field] = changes[field];
    });

    return (obj);
}

function deleteAttributes(obj, changes) {
    assert.object(obj, 'obj');
    assert.object(changes, 'changes');

    FIELDS.forEach(function (field) {
        if (changes[field]) {
            if (!obj[field])
                obj[field] = {};

            Object.keys(changes[field]).forEach(function (key) {
                delete obj[field][key];
            });
        }
    });

    return (obj);
}

// History only: allow any attribute to be reset

function setAttributes(obj, changes) {
    assert.object(obj, 'obj');
    assert.object(changes, 'changes');

    Object.keys(obj).forEach(function (k) {
        if (!changes[k]) {
            changes[k] = obj[k];
        }
    });

    return (changes);
}


Attributes.prototype.applyChange = function applyChange(obj, change, action) {
    assert.object(obj, 'obj');
    assert.object(change, 'change');
    assert.ok(action === 'update' ||
        action === 'replace' ||
        action === 'delete' ||
        action === 'set');

    var updatefunc;
    if (action === 'update') {
        updatefunc = updateAttributes;
    } else if (action === 'replace') {
        updatefunc = replaceAttributes;
    } else if (action === 'delete') {
        updatefunc = deleteAttributes;
    } else if (action === 'set') {
        updatefunc = setAttributes;
    }

    return (updatefunc(obj, change));
};


function assemble(app, svc, inst, field) {
    var obj = {};

    if (app[field]) {
        Object.keys(app[field]).forEach(function (key) {
            obj[key] = app[field][key];
        });
    }

    if (svc[field]) {
        Object.keys(svc[field]).forEach(function (key) {
            obj[key] = svc[field][key];
        });
    }

    if (inst[field]) {
        Object.keys(inst[field]).forEach(function (key) {
            obj[key] = inst[field][key];
        });
    }

    return (obj);
}

/*
 * Given an application, service, and instance, assemble the union of attributes
 * from those respective objects.
 *
 * For example, this function is used to generate the zone parameters passed to
 * VMAPI from app.params, svc.params, and inst.params.  The instance params
 * override the service parameters, and the service parameters override the
 * application parameters.
 */
function assembleAttributes(app, svc, inst) {
    var attributes = {};

    attributes.params = assemble(app, svc, inst, 'params');
    attributes.metadata = assemble(app, svc, inst, 'metadata');
    attributes.manifests = assemble(app, svc, inst, 'manifests');

    return (attributes);
}



// -- Manifest and metadata manipulation

function resolveManifests(manifests, cb) {
    var self = this;

    assert.object(manifests, 'manifests');

    var uuids = [];
    Object.keys(manifests).forEach(function (key) {
        assert.string(manifests[key], 'manifests[key]');
        uuids.push(manifests[key]);
    });

    vasync.forEachParallel({
        func: self.model.getManifest.bind(self.model),
        inputs: uuids
    }, function (err, results) {
        if (err)
            return (cb(err));
        return (cb(null, results.successes));
    });
}

/*
 * The config-agent inside this zone will retrieve the metadata from SAPI, so
 * there's no need to deliver that same metadata through VMAPI.  The only
 * metadata needed to bootstrap the zone's configuration is the SAPI URL and the
 * user-script.
 */
function sanitizeMetadata(metadata) {
    var customer_metadata = {};

    var allowed_keys = [ 'SAPI_URL', 'sapi_url', 'SAPI-URL', 'sapi-url',
        'user-script', 'assets-ip' ];

    if (metadata.hasOwnProperty('pass_vmapi_metadata_keys') &&
            util.isArray(metadata.pass_vmapi_metadata_keys)) {
        allowed_keys = allowed_keys.concat(metadata.pass_vmapi_metadata_keys);
    }

    allowed_keys.forEach(function (key) {
        if (metadata && metadata[key])
            customer_metadata[key] = metadata[key];
    });

    return (customer_metadata);
}

function getParentObjects(uuid, cb) {
    var self = this;

    assert.string(uuid, 'uuid');
    assert.func(cb, 'cb');

    var objs = {};

    async.waterfall([
        function (subcb) {
            self.model.getInstance(uuid, function (err, inst) {
                objs.instance = inst;
                subcb(err);
            });
        },

        function (subcb) {
            self.model.getService(objs.instance.service_uuid,
                function (err, svc) {
                objs.service = svc;
                subcb(err);
            });
        },
        function (subcb) {
            self.model.getApplication(objs.service.application_uuid,
                function (err, app) {
                objs.application = app;
                subcb(err);
            });
        }
    ], function (err) {
        return (cb(err, objs));
    });
}

Attributes.prototype.generateZoneParams = generateZoneParams;
function generateZoneParams(uuid, cb) {
    var self = this;
    var log = self.log;

    assert.string(uuid, 'instance uuid');
    assert.func(cb, 'cb');

    async.waterfall([
        function (subcb) {
            getParentObjects.call(self, uuid, subcb);
        },
        function (objs, subcb) {
            /*
             * There is no zone for an agent service type, so we
             * return an empty params object
             */
            if (objs.instance.type === 'agent') {
                log.info('no generateZoneParams for %s, ' +
                    'service type agent', uuid);
                return (subcb(null, {}));
            }

            var attributes = assembleAttributes(
                objs.application, objs.service, objs.instance);

            var params = attributes.params;
            params.owner_uuid = objs.application.owner_uuid;
            params.uuid = objs.instance.uuid;

            /*
             * SAPI only supports the joyent-minimal brand.
             */
            params.brand = 'joyent-minimal';

            // SERVER_UUID and ZONE_UUID are **deprecated**. See SAPI-248.
            // When (either manually, or codified in `sdcadm`) we know that
            // all components using these have been upgraded, then we
            // can remove this from SAPI.
            attributes.metadata.SERVER_UUID = params.server_uuid;
            attributes.metadata.ZONE_UUID = objs.instance.uuid;

            params.customer_metadata =
                sanitizeMetadata(attributes.metadata);

            if (!params.networks)
                return (subcb(null, params));

            resolveNetworks.call(self, params.networks, params.owner_uuid,
                function (err, uuids) {
                if (err &&
                    err.name !== 'UnsupportedOperationError') {
                    log.error(err, 'failed to resolve ' +
                        'networks');
                    return (subcb(err));
                }

                /*
                 * If NAPI isn't available, then just leave the
                 * network names alone without resolving them to
                 * UUIDs.  In proto mode, the zone won't
                 * actually be created.
                 */
                if (err &&
                    err.name === 'UnsupportedOperationError') {
                    assert.ok(self.model.proto_mode);
                    return (subcb(null, params));
                }

                delete params.networks;
                params.networks = uuids;

                return (subcb(null, params));
            });
        }
    ], cb);
}

Attributes.prototype.generateZoneConfig = generateZoneConfig;
function generateZoneConfig(uuid, cb) {
    var self = this;

    assert.string(uuid, 'instance uuid');
    assert.func(cb, 'cb');

    async.waterfall([
        function (subcb) {
            getParentObjects.call(self, uuid, subcb);
        },
        function (objs, subcb) {
            var attributes = assembleAttributes(
                objs.application, objs.service, objs.instance);

            var params = attributes.params;

            // SERVER_UUID, INSTANCE_UUID and ZONE_UUID are **deprecated**. See
            // SAPI-248. When (either manually, or codified in `sdcadm`) we know
            // that all components using these have been upgraded, then we can
            // remove this from SAPI.
            attributes.metadata.SERVER_UUID =
                params.server_uuid || self.model.server_uuid;
            attributes.metadata.ZONE_UUID = objs.instance.uuid;
            attributes.metadata.INSTANCE_UUID = objs.instance.uuid;

            resolveManifests.call(self, attributes.manifests,
                function (err, manifests) {
                if (err)
                    return (cb(err));

                assert.arrayOfObject(manifests);

                var config = {
                    manifests: manifests,
                    metadata: attributes.metadata
                };

                /*
                 * It's a PITA to have the user-script in the
                 * zone's metadata.  It clutters up the log, and
                 * encourages consumers to use it in an
                 * inappropriate way.  The authoritative
                 * user-script will come from the metadata API,
                 * not SAPI.
                 */
                delete config.metadata['user-script'];

                return (subcb(null, config));
            });
        }
    ], cb);
}


// -- Validation helper functions

function validManifests(manifests, cb) {
    var self = this;

    assert.object(manifests, 'manifests');

    var uuids = [];
    Object.keys(manifests).forEach(function (key) {
        assert.string(manifests[key], 'manifests[key]');
        uuids.push(manifests[key]);
    });

    vasync.forEachParallel({
        func: function (uuid, subcb) {
            self.model.getManifest(uuid, function (err) {
                subcb(err);
            });
        },
        inputs: uuids
    }, function (err) {
        return (cb(err));
    });
}

function validImage(uuid, cb) {
    var log = this.log;
    var imgapi = this.model.imgapi;

    assert.string(uuid, 'uuid');

    if (this.model.proto_mode && !this.model.proto_transition) {
        log.info('in proto mode, assume image %s is valid', uuid);
        return (cb(null));
    }

    log.debug('validating image_uuid %s', uuid);

    imgapi.getImage(uuid, function (err, image) {
        if (err || !image) {
            var msg = sprintf(
                'no such image in local IMGAPI: %s', uuid);
            log.error(err, msg);
            return (cb(new Error(msg)));
        }

        return (cb(null));
    });

    return (null);
}

function validParams(params, cb) {
    var self = this;
    var log = self.log;

    assert.object(params, 'params');

    async.waterfall([
        function (subcb) {
            if (!params.image_uuid)
                return (subcb(null));
            validImage.call(self, params.image_uuid,
                function (err) {
                subcb(err);
            });
        },
        function (subcb) {
            if (!params.networks)
                return (subcb(null));

            resolveNetworks.call(self, params.networks, params.owner_uuid,
                function (err) {
                if (err &&
                    err.name === 'UnsupportedOperationError' &&
                    self.model.proto_mode) {
                    log.info('skipping validation of ' +
                        'network names in proto mode');
                    err = null;
                }

                return (subcb(err));
            });

            return (null);
        }
    ], function (err) {
        return (cb(err));
    });

    return (null);
}

function validType(type, cb) {
    var self = this;
    var log = self.log;

    var VALID_TYPES = ['vm', 'agent'];

    assert.string(type, 'type');

    if (VALID_TYPES.indexOf(type) === -1) {
        var msg = sprintf(
            'service type is invalid: %s', type);
        var err = new Error(msg);
        log.error(err, msg);
        return (cb(err));
    }
    return (cb());
}

/*
 * General validation for params and metadata which applies to all applications,
 * services, and instances.
 */
Attributes.prototype.validate = function validate(obj, opts, cb) {
    var self = this;
    var log = this.log;

    assert.object(obj, 'obj');

    if (arguments.length === 2) {
        cb = opts;
        opts = {};
    }

    assert.object(opts, 'opts');
    assert.func(cb, 'cb');

    log.debug({ obj: obj, opts: opts }, 'validating object');

    async.waterfall([
        function (subcb) {
            /*
             * Only validate type for service objects
             */
            if (!obj.application_uuid)
                return (subcb(null));
            validType.call(self, obj.type, function (err) {
                subcb(err);
            });
        },
        function (subcb) {
            if (!obj.params)
                return (subcb(null));
            validParams.call(self, obj.params, function (err) {
                subcb(err);
            });
        },
        function (subcb) {
            if (!obj.manifests)
                return (subcb(null));
            validManifests.call(self, obj.manifests,
                function (err) {
                subcb(err);
            });
        }
    ], cb);
};


// -- Other helper functions

/*
 * Resolve an array of network names (e.g., "admin") to NAPI UUIDs.  If the
 * input argument is an array of objects, assume that these are the actual
 * network UUIDs and don't resolve the network names.
 */
function resolveNetworks(names, owner, cb) {
    var log = this.log;
    var nicParams;

    if (this.model.proto_mode) {
        return (cb(new mod_errors.UnsupportedOperationError(
            'NAPI not available in proto mode')));
    }

    if (names.length > 0) {
        var first = names[0];

        if (typeof (first) !== 'string') {
            log.debug('resolveNetworks() passed an array of ' +
                'objects, assuming they\'re proper NAPI networks');
            return (cb(null, names));
        }
    }

    /*
     * We shouldn't actually be assuming we're only going to get one page worth
     * of results, but until node-sdc-clients gives us a better streaming
     * interface for this, we'll make sure we have enough predicates in place
     * that this shouldn't be a problem.
     */
    nicParams = { name: names };
    if (owner) {
        nicParams['provisionable_by'] = owner;
    }
    this.model.napi.listNetworks(nicParams, function (err, networks) {
        if (err) {
            log.error(err, 'failed to list networks');
            return (cb(err));
        }

        var uuids = [];

        names.forEach(function (name) {
            networks.forEach(function (network) {
                if (name === network.name)
                    uuids.push(network.uuid);
            });
        });

        if (names.length !== uuids.length) {
            var msg = 'invalid network name';
            log.error(msg);
            return (cb(new Error(msg)));
        }

        log.debug({
            names: names,
            uuids: uuids
        }, 'resolved network names');

        return (cb(null, uuids));
    });

    return (null);
}
