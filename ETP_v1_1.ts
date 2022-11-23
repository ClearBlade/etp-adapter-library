const etp: typeof import("etp/lib/Etp") = require("etp");
const convert = require('xml-js');

const avro = etp.avro;
const sc = new etp.SchemaCache();

function ETP_v1_1(options) {

    const ETP_STREAM_REQUEST_MQTT_TOPIC = "etp/stream/request";
    const ETP_STREAM_RESPONSE_MQTT_TOPIC = "etp/stream/response";
    const ETP_STREAMING_DATA_MQTT_TOPIC_TEMPLATE = "etp/stream/incoming/<well_uid>/<wellbore_uid>/<log_uid>";

    // TODO - create these collections and their schemas within the library if needed in the future
    var _logCollection = ClearBladeAsync.Collection('etp_v1_1_logs');
    var _wellCollection = ClearBladeAsync.Collection('etp_v1_1_wells');
    var _rigCollection = ClearBladeAsync.Collection('etp_v1_1_rigs');
    var _wellboreCollection = ClearBladeAsync.Collection('etp_v1_1_wellbores');

    var _messageId = 1;

    var _client = null;
    var _isConnected = false;
    var _disconnectCallback = null;
    var _mqttClient = null;
    var _channelDetails = {};
    var _channelIDsByURI = {};

    var _destinationLogOnStreamStartOptions = null;

    if (options !== undefined && options.createDestinationLogOnStreamStart) {
        if (options.destinationLogName === undefined || options.destinationLogName === "") {
            throw "ETP_v1_1 - Initialize - options.destinationLogName required when enabling creation of destination log on stream start"; 
        } else if (options.destinationLogUid === undefined || options.destinationLogUid === "") {
            throw "ETP_v1_1 - Initialize - options.destinationLogUid required when enabling creation of destination log on stream start"; 
        } else if (options.destinationMnemonics === undefined || !Array.isArray(options.destinationMnemonics)) {
            throw "ETP_v1_1 - Initialize - options.destinationMnemonics required when enabling creation of destination log on stream start"; 
        }
        _destinationLogOnStreamStartOptions = {
            logName: options.destinationLogName,
            logUid: options.destinationLogUid,
            mnemonics: options.destinationMnemonics
        };
    }
    
    function Connect(websocketUrl, username, password, disconnectCallback) {
        _disconnectCallback = disconnectCallback;
        var options = {
            url: websocketUrl,
            useTLS: websocketUrl.startsWith("wss"),
            username: username,
            password: password,
            onMessage: _onMessage,
            onConnLost: _onConnLost,
            protocols: ["energistics-tp"],
        }
        _client = new WebSocket.Client(options);
        try {
            _client.connect();
        } catch(e) {
            throw "ETP_v1_1 - Connect - Websocket failed to connect: " + e;
        }
        _isConnected = true;
        console.log("ETP_v1_1 - Connect - Websocket connected");
        try {
            _writeMessageToWebsocket(_generateRequestSessionMessage());
        } catch (e) {
            console.log("ETP_v1_1 - Connect - Failed to Request Session: " + e);
            throw e;
        } 

    }

    async function CreateLogInStore(wellUid, wellboreUid, logUid, logName, mnemonics) {
        // TODO - maybe add a check before creating? also should add some real error checking, but it's working for now
        const uri = "eml://witsml14/well(" + wellUid + ")/wellbore(" + wellboreUid + ")/log(" + logUid + ")";
        console.log("ETP_v1_1 - CreateLogInStore - Creating log with URI: " + uri);
        // have to use the xml-js non-compact JSON format due to the XML structure here, so it's verbose on purpose
        var dataObjectAsJSON = {
            elements: [{
                "type": "element",
                name: "logs",
                attributes: {
                    "xmlns:xlink": "http://www.w3.org/1999/xlink",
                    "xmlns:xsi": "http://www.w3.org/2001/XMLSchema-instance",
                    "xmlns:dc": "http://purl.org/dc/terms/",
                    "xmlns:gml": "http://www.opengis.net/gml/3.2",
                    "version": "1.4.1.1",
                    "xmlns": "http://www.witsml.org/schemas/1series"
                },
                elements: [{
                    "type": "element",
                    name: "log",
                    attributes: {
                        "uidWell": wellUid,
                        "uidWellbore": wellboreUid,
                        "uid": logUid
                    },
                    elements: [{
                        "type": "element",
                        name: "nameWell",
                        elements: [{
                            "type": "text",
                            text: "noop" // this can't be an empty string, but doesn't have to actually be the well name, that's all figured out for us on the server side
                        }]
                    }, {
                        "type": "element",
                        name: "nameWellbore",
                        elements: [{
                            "type": "text",
                            text: "noop" // same as above nameWell element
                        }]
                    }, {
                        "type": "element",
                        name: "name",
                        elements: [{
                            "type": "text",
                            text: logName
                        }]
                    }, {
                        "type": "element",
                        name: "indexType",
                        elements: [{
                            "type": "text",
                            text: "date time"
                        }]
                    }, {
                        "type": "element",
                        name: "indexCurve",
                        elements: [{
                            "type": "text",
                            text: "Time"
                        }]
                    }]
                }]
            }]
        };
        for (var x = 0; x < mnemonics.length; x++) {
            var logCurveInfoElement = {
                "type": "element",
                name: "logCurveInfo",
                attributes: {
                    uid: mnemonics[x].mnemonic
                },
                elements: [{
                    "type": "element",
                    name: "mnemonic",
                    elements: [{
                        "type": "text",
                        text: mnemonics[x].mnemonic
                    }]
                }, {
                    "type": "element",
                    name: "unit",
                    elements: [{
                        "type": "text",
                        text: mnemonics[x].unit
                    }]
                }, {
                    "type": "element",
                    name: "typeLogData",
                    elements: [{
                        "type": "text",
                        text: mnemonics[x].dataType
                    }]
                }]
            }
            dataObjectAsJSON.elements[0].elements[0].elements.push(logCurveInfoElement);
        }
        var xmlDataObject = convert.js2xml(dataObjectAsJSON, {compact: false});
        _writeMessageToWebsocket(_generateStorePutObjectMessage(uri, xmlDataObject, "log"));
    }

    async function InitializeDiscovery(refreshIntervalInMinutes) {
        function sendGetResourceMessages() {
            console.log("ETP_v1_1 - InitializeDiscovery - Sending Get Resources Messages");
            try {
                _writeMessageToWebsocket(_generateDiscoveryGetResourcesMessage(DefaultETPURIs.Log));
                _writeMessageToWebsocket(_generateDiscoveryGetResourcesMessage(DefaultETPURIs.Well));
                _writeMessageToWebsocket(_generateDiscoveryGetResourcesMessage(DefaultETPURIs.Wellbore));
            } catch (e) {
                console.log("ETP_v1_1 - InitializeDiscovery - Failed to discover resources: " + e);
                throw e;
            }
        }
        sendGetResourceMessages();
        setInterval(sendGetResourceMessages, refreshIntervalInMinutes * 60 * 1000);
        _mqttClient = new MQTT.Client();
        console.log("subscribing to mqtt request topic");
        await _mqttClient.subscribe(ETP_STREAM_REQUEST_MQTT_TOPIC, _onMQTTMessage);
    }

    function StartStreamForLogUri(logUri) {
        console.log("ETP_v1_1 - StartStreamForLogUri - Sending channel streaming describe message");
        try {
            _writeMessageToWebsocket(_generateChannelStreamingDescribeMessage(logUri));
        } catch (e) {
            console.log("ETP_v1_1 - StartStreamForLogUri - Failed to describe streaming channels: " + e);
            throw e;
        }
    }

    function StopStreamForLogUri(logUri) {
        console.log("ETP_v1_1 - StopStreamForLogUri - TODO");
    }

    function WriteLogDataToStore(wellUid, wellboreUid, logUid, logData) {
        const uri = "eml://witsml14/well(" + wellUid + ")/wellbore(" + wellboreUid + ")/log(" + logUid + ")";
        var dataObjectAsJSON = {
            logs: {
                _attributes: {
                    "xmlns:xlink": "http://www.w3.org/1999/xlink",
                    "xmlns:xsi": "http://www.w3.org/2001/XMLSchema-instance",
                    "xmlns:dc": "http://purl.org/dc/terms/",
                    "xmlns:gml": "http://www.opengis.net/gml/3.2",
                    "version": "1.4.1.1",
                    "xmlns": "http://www.witsml.org/schemas/1series"
                },
                log: {
                    _attributes : {
                        "uidWell": wellUid,
                        "uidWellbore": wellboreUid,
                        "uid": logUid
                    },
                    logData: []
                }
            }
        };
        for (var x = 0; x < logData.length; x++) {
            var mnemonicListCSV = "";
            var unitListCSV = "";
            var dataListCSV = "";
            var mnemonics = Object.keys(logData[x]);
            for (var y = 0; y < mnemonics.length; y++) {
                mnemonicListCSV += mnemonics[y] + ",";
                unitListCSV += ","; // units aren't actually required, but the unitList node is in the xml, and it needs to match the same number of mnemonics being updated
                dataListCSV += logData[x][mnemonics[y]] + ",";
            }
            //trim trailing comman from all CSV strings
            mnemonicListCSV = mnemonicListCSV.replace(/,$/, '');
            unitListCSV = unitListCSV.replace(/,$/, '');
            dataListCSV = dataListCSV.replace(/,$/, '');
            var logDataObj = {
                mnemonicList: {
                    _text: mnemonicListCSV
                },
                unitList: {
                    _text: unitListCSV
                },
                data: {
                    _text: dataListCSV
                }
            };
            dataObjectAsJSON.logs.log.logData.push(logDataObj);
        }
        var xmlDataObject = convert.js2xml(dataObjectAsJSON, {compact: true});
        _writeMessageToWebsocket(_generateStorePutObjectMessage(uri, xmlDataObject, "log"));
    }

    async function _writeMessageToWebsocket(message) {
        console.log("ETP_v1_1 - _writeMessageToWebsocket - Writing message to websocket");
        var writer = new avro.BinaryWriter(sc);
        writer.writeDatum("Energistics.Datatypes.MessageHeader", message.header);
        writer.writeDatum(message.schema, message.message);
        var dataToSend = writer.getBuffer();
        var dataArray = new Uint8Array(dataToSend.buffer);
        await _client.write(dataArray);
    }

    function _onMQTTMessage(topic, message) {
        console.log("ETP_v1_1 - _onMQTTMessage - MQTT message received on topic: " + topic);
        var streamRequest = JSON.parse(message.payload);
        switch (streamRequest.command) {
            case "start":
                if (_destinationLogOnStreamStartOptions !== null) {
                    CreateLogInStore(streamRequest.wellUid, streamRequest.wellboreUid, _destinationLogOnStreamStartOptions.logUid, _destinationLogOnStreamStartOptions.logName, _destinationLogOnStreamStartOptions.mnemonics);
                }
                var uri = _buildLogURIFromUIDs(streamRequest.wellUid, streamRequest.wellboreUid, streamRequest.logUid);
                try {
                    _writeMessageToWebsocket(_generateChannelStreamingDescribeMessage(uri));
                } catch (e) {
                    console.log("ETP_v1_1 - _onMQTTMessage - Failed to describe streaming channels: " + e);
                    streamRequest.error = true;
                    streamRequest.reason = e;
                    _mqttClient.publish(ETP_STREAM_RESPONSE_MQTT_TOPIC, JSON.stringify(streamRequest));
                }
                streamRequest.error = false;
                _mqttClient.publish(ETP_STREAM_RESPONSE_MQTT_TOPIC, JSON.stringify(streamRequest));
                break;
            case "stop":
                // TODO - implement
            default:
                console.log("ETP_v1_1 - _onMQTTMessage - Unexpected stream request command: " + streamRequest.command);
                break;
        }
    }

    function _buildLogURIFromUIDs(wellUid, wellboreUid, logUid) {
        return "eml://witsml14/well(" + wellUid + ")/wellbore(" + wellboreUid + ")/log(" + logUid + ")";
    }

    function _onMessage(payload_bytes) {
        console.log("ETP_v1_1 - _onMessage - Message received on websocket");
        var reader = new avro.BinaryReader(sc, Buffer.from(payload_bytes));
        var header = reader.decode("Energistics.Datatypes.MessageHeader", Array.from(reader.buffer));
        var body = reader.readDatum(sc.find(header.protocol, header.messageType));
        switch (header.protocol) {
            case ETPProtocolID.Core:
                switch (header.messageType) {
                    case CoreMessageTypeID.OpenSession:
                        // received OpenSession, now let's send the simple channel streaming start message, no response is made here
                        // but sending this message is required before setting up any chnnaels so we just auto send after opening session
                        _writeMessageToWebsocket(_generateChannelStreamingStartMessage());
                        break;
                    default:
                        console.log("ETP_v1_1 - _onMessage - No handler implemented for Message Type: " + header.messageType + " Protocol ID: " + header.protocol);
                        break;
                }
                break;
            case ETPProtocolID.ChannelStreaming:
                switch (header.messageType) {
                    case ChannelStreamingMessageTypeID.ChannelMetadata:
                        // // received streaming describe response, next we filter for channel names we care about and start streaming the data
                        _writeMessageToWebsocket(_generateChannelStreamingChannelStreamingStartMessage(body));
                        break;
                    case ChannelStreamingMessageTypeID.ChannelData:
                        _processIncomingStreamingChannelData(body);
                        break;
                    default:
                        console.log("ETP_v1_1 - _onMessage - No handler implemented for Message Type: " + header.messageType + " Protocol ID: " + header.protocol);
                        break;
                }
                break;
            case ETPProtocolID.Discovery:
                switch (header.messageType) {
                    case DiscoveryMessageTypeID.GetResourcesResponse:
                        _handleGetResourcesResponse(body);
                        break;
                    default:
                        console.log("ETP_v1_1 - _onMessage - No handler implemented for Message Type: " + header.messageType + " Protocol ID: " + header.protocol);
                        break;
                }
                break;
            case ETPProtocolID.Store:
                switch (header.messageType) {
                    case StoreMessageTypeID.Object:
                        console.log(typeof body.dataObject.data);
                        console.log(String.fromCharCode.apply(String, body.dataObject.data));
                        console.log(body.dataObject.data.toString());
                        //_handleStoreObjectResponse(body);
                        break;
                    default:
                        console.log("ETP_v1_1 - _onMessage - No handler implemented for Message Type: " + header.messageType + " Protocol ID: " + header.protocol);
                        break;
                }
                break;
            default:
                console.log("ETP_v1_1 - _onMessage - No handler implemented for Protocol ID: " + header.protocol);
                break;
        }
    }

    function _handleStoreObjectResponse(message) {
        console.log(message.dataObject.data.toString());
    }

    function _onConnLost(reason) {
        console.log("ETP_v1_1 - _onConnLost - Websocket connection lost: " + reason);
        _isConnected = false;
        if (_disconnectCallback !== null) {
            _disconnectCallback(reason);
        }
    }

    function _handleGetResourcesResponse(response) {
        console.log(response);
        // determine content type of resource
        var contentType = _getTypeFromResourceContentTypeString(response.resource.contentType);
        switch (contentType) {
            case ETPResourceContentTypes.Log:
                _upsertLog(response);
                break;
            case ETPResourceContentTypes.Well:
                _upsertWell(response);
                
                break;
            case ETPResourceContentTypes.Wellbore:
                _upsertWellbore(response);
                break;
            default:
                console.log("ETP_v1_1 - _handleGetResourcesResponse - No handler implemented for Resource Content Type: " + contentType);
                break;
        }
    }

    async function _upsertLog(resourceMessage) {
        console.log("ETP_v1_1 - _upsertLog - Upserting info for uri: " + resourceMessage.resource.uri);
        var uidsFromURI = _getUidsFromURI(resourceMessage.resource.uri);
        if (uidsFromURI === null) {
            return;
        }
        var wellboreObj = {
            uid: uidsFromURI.log,
            uri: resourceMessage.resource.uri,
            name: resourceMessage.resource.name,
            last_updated: new Date(),
            custom_data: resourceMessage.resource.customData,
            last_changed: new Date(resourceMessage.resource.lastChanged / 1000),
            object_notifiable: resourceMessage.resource.objectNotifiable,
            channel_subscribable: resourceMessage.resource.channelSubscribable,
            parent_well_uid: uidsFromURI.well,
            parent_wellbore_uid: uidsFromURI.wellbore
        };
        try {
            await _logCollection.upsert(wellboreObj, "uri");
        } catch (e) {
            console.log("ETP_v1_1 - _upsertWellbore - Failed to upsert wellbore info: " + e);
        }
    }

    async function _upsertWell(resourceMessage) {
        console.log("ETP_v1_1 - _upsertWell - Upserting info for uri: " + resourceMessage.resource.uri);
        var uidsFromURI = _getUidsFromURI(resourceMessage.resource.uri);
        if (uidsFromURI === null) {
            return;
        }
        var wellObj = {
            uid: uidsFromURI.well,
            uri: resourceMessage.resource.uri,
            name: resourceMessage.resource.name,
            last_updated: new Date(),
            custom_data: resourceMessage.resource.customData,
            last_changed: new Date(resourceMessage.resource.lastChanged / 1000),
            object_notifiable: resourceMessage.resource.objectNotifiable,
            channel_subscribable: resourceMessage.resource.channelSubscribable
        };
        try {
            await _wellCollection.upsert(wellObj, "uri");
        } catch (e) {
            console.log("ETP_v1_1 - _upsertWell - Failed to upsert well info: " + e);
        }
    }

    async function _upsertWellbore(resourceMessage) {
        console.log("ETP_v1_1 - _upsertWellbore - Upserting info for uri: " + resourceMessage.resource.uri);
        var uidsFromURI = _getUidsFromURI(resourceMessage.resource.uri);
        if (uidsFromURI === null) {
            return;
        }
        var wellboreObj = {
            uid: uidsFromURI.wellbore,
            uri: resourceMessage.resource.uri,
            name: resourceMessage.resource.name,
            last_updated: new Date(),
            custom_data: resourceMessage.resource.customData,
            last_changed: new Date(resourceMessage.resource.lastChanged / 1000),
            object_notifiable: resourceMessage.resource.objectNotifiable,
            channel_subscribable: resourceMessage.resource.channelSubscribable,
            parent_well_uid: uidsFromURI.well
        };
        try {
            await _wellboreCollection.upsert(wellboreObj, "uri");
        } catch (e) {
            console.log("ETP_v1_1 - _upsertWellbore - Failed to upsert wellbore info: " + e);
        }
    }

    function _getUidsFromURI(uri) {
        // another ugly string parser, wrapping in a try/catch just in case my assumptions are wrong
        try {
            var prefixTrimmed = uri.replace(/^eml:\/\/witsml14\//, '');
            var splitOnSlash = prefixTrimmed.split("/");
            var uris = {};
            for (var x = 0; x < splitOnSlash.length; x++) {
                var splitOnOpenParenthesis = splitOnSlash[x].split("(");
                uris[splitOnOpenParenthesis[0]] = splitOnOpenParenthesis[1].slice(0, -1);
            }
            return uris;
        } catch (e) {
            console.log("ETP_v1_1 - _getUidsFromURI - Unable to parse out UIDs from URI: " + uri);
            return null;
        }
    }

    function _getTypeFromResourceContentTypeString(contentTypeString) {
        // get's ugly here
        var contentType = "";
        // application/x-witsml+xml;version=1.4.1.1;type=well
        var splitOnSemiColon = contentTypeString.split(";");
        for (var x = 0; x < splitOnSemiColon.length; x++) {
            if (splitOnSemiColon[x].includes("=")) {
                var splitOnEquals = splitOnSemiColon[x].split("=");
                if (splitOnEquals[0] === "type") {
                    contentType = splitOnEquals[1];
                }
            }
        }
        if (contentType === "") {
            console.log("ETP_v1_1 - _getTypeFromResourceContentTypeString - Unable to parse type from resource content type string: " + contentTypeString);
        }
        return contentType;
    }

    function _processIncomingStreamingChannelData(data) {
        // refactoring to publish on topics with uids rather than just calling a callback, might get ugly
        // we first need to loop through all received channel data, and figure out the different log uids each came from
        var processedMessages = {};
        for (var x = 0; x < data.data.length; x++) {
            var channelInfo = _channelDetails[data.data[x].channelId];
            var logUid = channelInfo.logUid;
            if (!processedMessages.hasOwnProperty(logUid)) {
                processedMessages[logUid] = {};
                var topic = ETP_STREAMING_DATA_MQTT_TOPIC_TEMPLATE.replace("<log_uid>", logUid);
                topic = topic.replace("<well_uid>", channelInfo.wellUid);
                topic = topic.replace("<wellbore_uid>", channelInfo.wellboreUid);
                processedMessages[logUid].topicToPublishOn = topic
            }
            // now within each individual log uid we found we then key on timestamp
            if (!processedMessages[logUid].hasOwnProperty(data.data[x].indexes[0])) {
                processedMessages[logUid][data.data[x].indexes[0]] = {};
            }
            var value = data.data[x].value.item[channelInfo.dataType];
            processedMessages[logUid][data.data[x].indexes[0]][channelInfo.channelName] = {
                "units": channelInfo.uom,
                "value": value
            };
        }
        // now loop through each logUid found
        for (var logUid in processedMessages) {
            // for each logUid lets build an array of objects to send
            var finalMessages = [];
            for (var timeKey in processedMessages[logUid]) {
                // skip our topic key we added to make life easy
                if (timeKey === "topicToPublishOn") {
                    continue;
                }
                var time = new Date(parseInt(timeKey) / 1000).toISOString();
                var message = {
                    time,
                };
                for (var valueKey in processedMessages[logUid][timeKey]) {
                    message[valueKey] = processedMessages[logUid][timeKey][valueKey];
                }
                finalMessages.push(message);
            }
            // now publish to the appropriate topic
            _mqttClient.publish(processedMessages[logUid].topicToPublishOn, JSON.stringify(finalMessages));
        }
    }

    function _generateHeader(protocol, messageType, correlationId, messageFlags) {
        console.log("ETP_v1_1 - _generateHeader - Generating Header");
        var header = new etp.Energistics.Datatypes.MessageHeader()
        header.protocol = protocol;
        header.messageType = messageType;
        header.messageId = _messageId;
        header.correlationId = correlationId;
        header.messageFlags = messageFlags;
        // increase message id by 1
        _messageId++;
        return header;
    }

    function _generateRequestSessionMessage() {
        console.log("ETP_v1_1 - _generateRequestSessionMessage - creating Core.RequestSession message");
        var protocolsToSupport = [{
            "id": ETPProtocolID.ChannelStreaming,
            "major": 1,
            "minor": 1,
            "role": "producer"
        }, {
            "id": ETPProtocolID.Discovery,
            "major": 1,
            "minor": 1,
            "role": "store"
        }, {
            "id": 4,
            "major": 1,
            "minor": 1,
            "role": "store"
        }, {
            "id": 5,
            "major": 1,
            "minor": 1,
            "role": "store"
        }, {
            "id": 6,
            "major": 1,
            "minor": 1,
            "role": "store"
        }];
        var header = _generateHeader(ETPProtocolID.Core, CoreMessageTypeID.RequestSession, 0, 0)
        var reqSession = new etp.Energistics.Protocol.Core.RequestSession();
        reqSession.applicationName = "clearblade-platform";
        reqSession.applicationVersion = "1.0.0.0";
        var supportedProtocols = [];
        for (var x = 0; x < protocolsToSupport.length; x++) {
            var sp = new etp.Energistics.Datatypes.SupportedProtocol();
            sp.protocol = protocolsToSupport[x].id;
            sp.role = protocolsToSupport[x].role;
            sp.protocolCapabilities = {};
            sp.protocolVersion.major = protocolsToSupport[x].major;
            sp.protocolVersion.minor = protocolsToSupport[x].minor;
            supportedProtocols.push(sp);
        }
        reqSession.requestedProtocols = supportedProtocols;
        return {
            header: header,
            message: reqSession,
            schema: "Energistics.Protocol.Core.RequestSession"
        };
    }

    function _generateChannelStreamingStartMessage() {
        console.log("ETP_v1_1 - _generateChannelStreamingStartMessage - creating ChannelStreaming.Start message");
        var header = _generateHeader(ETPProtocolID.ChannelStreaming, ChannelStreamingMessageTypeID.Start, 0, 0);
        var start = new etp.Energistics.Protocol.ChannelStreaming.Start();
        start.maxMessageRate = 1000;
        start.maxDataItems = 10000;
        return {
            header,
            message: start,
            schema: "Energistics.Protocol.ChannelStreaming.Start"
        };
    }

    function _generateChannelStreamingDescribeMessage(uri) {
        console.log("ETP_v1_1 - _generateChannelStreamingDescribeMessage - creating ChannelStreaming.ChannelDescribe message");
        var header = _generateHeader(ETPProtocolID.ChannelStreaming, ChannelStreamingMessageTypeID.ChannelDescribe, 0, 0);
        var describe = new etp.Energistics.Protocol.ChannelStreaming.ChannelDescribe();
        describe.uris = [uri];
        return {
            header,
            message: describe,
            schema: "Energistics.Protocol.ChannelStreaming.ChannelDescribe"
        };
    }

    function _generateChannelStreamingChannelStreamingStartMessage(allChannels) {
        console.log("ETP_v1_1 - _generateChannelStreamingChannelStreamingStartMessage - creating ChannelStreaming.ChannelStreamingStart message")
        var header = _generateHeader(ETPProtocolID.ChannelStreaming, ChannelStreamingMessageTypeID.ChannelStreamingStart, 0, 0);
        var streamStart = new etp.Energistics.Protocol.ChannelStreaming.ChannelStreamingStart();
        var channels = [];
        for (var x = 0; x < allChannels.channels.length; x++) {
            var channel = new etp.Energistics.Datatypes.ChannelData.ChannelStreamingInfo();
            channel.channelId = allChannels.channels[x].channelId;
            channel.receiveChangeNotification = true;
            channels.push(channel);
            // add parsed uids to make life easier when building topic to publish data on
            var uids = _getUidsFromURI(allChannels.channels[x].channelUri);
            allChannels.channels[x].logUid = uids.log;
            allChannels.channels[x].wellUid = uids.well;
            allChannels.channels[x].wellboreUid = uids.wellbore;
            _channelDetails[allChannels.channels[x].channelId] = allChannels.channels[x];
        }
        streamStart.channels = channels;
        return {
            header,
            message: streamStart,
            schema: "Energistics.Protocol.ChannelStreaming.ChannelStreamingStart"
        };
    }

    function _generateDiscoveryGetResourcesMessage(uri) {
        console.log("ETP_v1_1 - _generateDiscoveryGetResourcesMessage - creating Discovery.GetResources message");
        var header = _generateHeader(ETPProtocolID.Discovery, DiscoveryMessageTypeID.GetResources, 0, 0);
        var getResources = new etp.Energistics.Protocol.Discovery.GetResources();
        getResources.uri = uri;
        return {
            header,
            message: getResources,
            schema: "Energistics.Protocol.Discovery.GetResources"
        };
    }

    function _generateStorePutObjectMessage(uri, dataObjData, contentType) {
        console.log("ETP_v1_1 - _generateStorePutObjectMessage - creating Store.PutObject message");
        var header = _generateHeader(ETPProtocolID.Store, StoreMessageTypeID.PutObject, 0, 0);
        var putObj = new etp.Energistics.Protocol.Store.PutObject();
        var dataObj = new etp.Energistics.Datatypes.Object.DataObject();
        var res = new etp.Energistics.Datatypes.Object.Resource();
        res.uri = uri;
        res.contentType = "application/x-witsml+xml;version=1.4.1.1;type=" + contentType;
        res.resourceType = "DataObject";
        dataObj.contentEncoding = "";
        dataObj.data = new Buffer(dataObjData);
        dataObj.resource = res;
        putObj.dataObject = dataObj;
        return {
            header,
            message: putObj,
            schema: "Energistics.Protocol.Store.PutObject"
        };
    }

    return {
        Connect,
        CreateLogInStore,
        InitializeDiscovery,
        StartStreamForLogUri,
        StopStreamForLogUri,
        WriteLogDataToStore,
    };
}

enum ETPProtocolID {
    Core                = 0,
    ChannelStreaming    = 1,
    Discovery           = 3,
    Store               = 4,
}

enum CoreMessageTypeID {
    RequestSession  = 1,
    OpenSession     = 2,
}

enum ChannelStreamingMessageTypeID {
    Start                   = 0,
    ChannelDescribe         = 1,
    ChannelMetadata         = 2,
    ChannelData             = 3,
    ChannelStreamingStart   = 4,
}

enum DiscoveryMessageTypeID {
    GetResources            = 1,
    GetResourcesResponse    = 2,
}

enum StoreMessageTypeID {
    GetObject       = 1,
    PutObject       = 2,
    DeleteObject    = 3,
    Object          = 4,
}

enum DefaultETPURIs {
    Log         = "eml://witsml14/log",
    Rig         = "eml://witsml14/rig",
    Well        = "eml://witsml14/well",
    Wellbore    = "eml://witsml14/wellbore",
}

enum ETPResourceContentTypes {
    Log         = "log",
    Rig         = "rig",
    Well        = "well",
    Wellbore    = "wellbore",
}
  
// @ts-ignore
global.ETP_v1_1 = ETP_v1_1;