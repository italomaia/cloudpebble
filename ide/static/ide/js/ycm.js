CloudPebble = CloudPebble || {};

// This is a drop-in replacement for $.ajax
// TODO: is this overkill? It seems to work, and means that very few changes to other code are required.
// TODO: If we do keep this, (a) stick it in another file, (b) make sure it's robust
var EventedWebSocket = function(host) {
    var self = this;
    var mSocket = null;
    var ids = {};

    _.extend(this, Backbone.Events);

    this.getSocket = function() {
        return mSocket;
    };

    this.connect = function() {
        mSocket = new WebSocket(host);
        mSocket.onerror = handle_socket_error;
        mSocket.onclose = handle_socket_close;
        mSocket.onmessage = handle_socket_message;
        mSocket.onopen = handle_socket_open;
    };

    this.close = function() {
        mSocket.close();
        mSocket = null;
    };

    var register_promise = function(promise) {
        var id;
        for (id = 0; id in ids; id++);
        ids[id] = promise;
        return id;
    };

    var trigger_promise = function(id, data) {
        var promise = ids[id];
        delete ids[id];
        // TODO: think about other failure conditions
        if ('success' in data && data['success'] == false) {
            promise.reject(data);
        }
        else {
            promise.resolve(data);
        }
    };


    this.send = function(data, timeout) {
        var d = $.Deferred();
        var id = register_promise(d);
        data._ws_message_id = id;
        var text = JSON.stringify(data);
        mSocket.send(text);

        if (typeof timeout !== "undefined") {
            setTimeout(function() {
                d.reject({'error': 'timeout'});
                delete ids[id];
            }, timeout);
        }

        return d.promise();
    };

    this.isOpen = function() {
        return (mSocket.readyState == WebSocket.OPEN);
    };

    var handle_socket_error = function(e) {
        self.trigger('error', e);
    };

    var handle_socket_open = function() {
        self.trigger('open');
    };

    var handle_socket_close = function(e) {
        self.trigger('close', e);
        mSocket = null;
        _.each(ids, function(promise, key) {
            promise.reject({'error': 'closed'})
        });
        ids = {};
    };

    var handle_socket_message = function(e) {
        var data = JSON.parse(e.data);
        var id = data._ws_message_id;
        if (id in ids) {
            trigger_promise(id, data);
        }
        // if id is not in ids, the message probably timed out.
    };
};

CloudPebble.YCM = new (function() {
    var self = this;
    var PING_INTERVAL = 90000;

    var mInitialised = false;
    var mIsInitialising = false;
    var mFailed = false;
    var mRestarting = false;
    var mURL = null;
    var mSocket = null;
    var mUUID = null;
    var mPingTimer = null;

    function pingServer() {
        ws_send('ping',{}).always(function() {
            mPingTimer = _.delay(pingServer, PING_INTERVAL);
        });
    }

    function ws_send(command, data, timeout) {
        var packet = {
            'command': command,
            'data': data
        };
        return mSocket.send(packet, timeout);
    }
    function sendBuffers() {
        var editors = CloudPebble.Editor.GetAllEditors();
        var pending = 0;
        _.each(editors, function(editor) {
            editor.patch_list = [];
            editor.patch_sequence = 0;
            ++pending;

            ws_send('create', {
                    filename: editor.file_path,
                    content: editor.getValue()
            }).done(function() {
                if(--pending == 0) {
                    console.log('restart done.');
                    $('.prepare-autocomplete').hide();
                    $('.footer-credits').show();
                    mInitialised = true;
                }
            }).fail(function() {
                mFailed = true;
                console.log('restart failed.');
                $('.prepare-autocomplete').text(gettext("Code completion resync failed."));
                throw "Restart failed";
            });
        });
    }

    this.initialise = function() {
        if(mInitialised || mIsInitialising || mFailed) {
            return;
        }
        mIsInitialising = true;
        var platforms = (CloudPebble.ProjectInfo.app_platforms || 'aplite,basalt');
        if(CloudPebble.ProjectInfo.sdk_version == '2') {
            platforms = 'aplite';
        }
        var sdk_version = CloudPebble.ProjectInfo.sdk_version;
        $.post('/ide/project/' + PROJECT_ID + '/autocomplete/init', {platforms: platforms, sdk: sdk_version})
            .done(function(data) {
                if(data.success) {
                    mUUID = data.uuid;
                    mURL = data.server + 'ycm/' + data.uuid;
                    // TODO: deal with wss://. Also, parse URLs properly?
                    mSocketHost = "ws://"+mURL.split("://")[1]+"/ws";
                    mSocket = new EventedWebSocket(mSocketHost);
                    mSocket.on('open', function() {
                        if(mRestarting) {
                            sendBuffers();
                        } else {
                            mInitialised = true;
                            mPingTimer = _.delay(pingServer, PING_INTERVAL);
                            $('.prepare-autocomplete').hide();
                            $('.footer-credits').show();
                        }
                    });
                    // TODO: test socket close/error restart
                    mSocket.on('close', function() {
                        self.restart();
                    });
                    mSocket.on('error', function() {
                        self.restart();
                    });

                    mSocket.connect();
                } else {
                    mFailed = true;
                    $('.prepare-autocomplete').text(gettext("Code completion unavailable."));
                }
            })
            .fail(function() {
                mFailed = true;
                $('.prepare-autocomplete').text(gettext("Code completion unavailable."));
            });
    };

    this.restart = function() {
        if(mRestarting) {
            return;
        }
        clearTimeout(mPingTimer);
        mPingTimer = null;
        mInitialised = false;
        mIsInitialising = false;
        mFailed = false;
        mRestarting = true;
        mURL = false;
        mSocket = null;
        mUUID = null;
        $('.prepare-autocomplete').text(gettext("Code completion lost; retrying...")).show();
        $('.footer-credits').hide();
        this.initialise();
    };

    this.getUUID = function() {
        return mUUID;
    };

    this.deleteFile = function(file) {
        var promise = $.Deferred();
        if(!mInitialised) {
            promise.reject();
            return promise.promise();
        }
        ws_send('delete', {
                filename: ((file.target == 'worker') ? 'worker_src/' : 'src/') + file.name
        }).done(function() {
            promise.resolve();
        }).fail(function() {
            promise.reject();
        });
        return promise.promise();
    };

    this.createFile = function(file, content) {
        var promise = $.Deferred();
        if(!mInitialised) {
            promise.reject();
            return promise.promise();
        }
        ws_send('create', {
                filename: ((file.target == 'worker') ? 'worker_src/' : 'src/') + file.name,
                content: content || ''
        }).done(function() {
            promise.resolve();
        }).fail(function() {
            promise.reject();
        });
        return promise.promise();
    };

    this.updateResources = function(resources) {
        if(!mInitialised) {
            return;
        }
        var defines = [];
        var counter = 1;
        _.each(resources, function(resource) {
            if(resource.kind != 'png-trans') {
                defines = defines.concat(_.map(resource.identifiers, function(id) {
                    return '#define RESOURCE_ID_' + id + ' ' + (counter++);
                }));
            } else {
                _.each(resource.identifiers, function(id) {
                    defines.push('#define RESOURCE_ID_' + id + '_BLACK ' + (counter++));
                    defines.push('#define RESOURCE_ID_' + id + '_WHITE ' + (counter++));
                })
            }
        });
        defines.push("");
        ws_send('create',{
                filename: 'build/src/resource_ids.auto.h',
                content: defines.join("\n")
        });
    };

    this.request = function(endpoint, editor, cursor) {
        var promise = $.Deferred();
        if(!mInitialised) {
            promise.reject();
            return promise.promise();
        }

        cursor = cursor || editor.getCursor();
        var these_patches = editor.patch_list;
        editor.patch_list = [];
        ws_send(endpoint, {
            file: editor.file_path,
            line: cursor.line,
            ch: cursor.ch,
            patches: these_patches
        }, 2000).done(function(data) {
            promise.resolve(data);
        }).fail(function(error) {
            editor.patch_list = these_patches.concat(editor.patch_list);
            promise.reject();
            // TODO: we moved the restart logic out of here. When that gets tested, remove this TODO.
        });
        return promise.promise();
    };
})();
