# ETP_v1_1 Library

## Overview

The ETP_v1_1.js Library can be added to your ClearBlade System to provide an easy interface to an ETP Server running v1.1. This libray currently supports Discovery, Streaming Data, Creating and Writing DataObjects to the store.

## Prerequisite

Currently this library expects a few existing Collections in your System, see below for their names and required data structures.

### etp_v1_1_logs

| Column Name          | Column Type | Index   | Unique Index |
| -------------------- | ----------- | ------- | ------------ |
| uid                  | string      |         |              |
| uri                  | string      | &check; | &check;      |
| name                 | string      |         |              |
| custom_data          | jsonb       |         |              |
| last_updated         | timestamp   |         |              |
| last_changed         | timestamp   |         |              |
| object_notifiable    | bool        |         |              |
| channel_subscribable | bool        |         |              |
| currently_subscribed | bool        |         |              |
| parent_well_uid      | string      |         |              |
| parent_wellbore_uid  | string      |         |              |

### etp_v1_1_wellbores

| Column Name          | Column Type | Index   | Unique Index |
| -------------------- | ----------- | ------- | ------------ |
| uid                  | string      |         |              |
| uri                  | string      | &check; | &check;      |
| name                 | string      |         |              |
| custom_data          | jsonb       |         |              |
| last_updated         | timestamp   |         |              |
| last_changed         | timestamp   |         |              |
| object_notifiable    | bool        |         |              |
| channel_subscribable | bool        |         |              |
| parent_well_uid      | string      |         |              |

### etp_v1_1_wells

| Column Name          | Column Type | Index   | Unique Index |
| -------------------- | ----------- | ------- | ------------ |
| uid                  | string      |         |              |
| uri                  | string      | &check; | &check;      |
| name                 | string      |         |              |
| custom_data          | jsonb       |         |              |
| last_updated         | timestamp   |         |              |
| last_changed         | timestamp   |         |              |
| object_notifiable    | bool        |         |              |
| channel_subscribable | bool        |         |              |

## API Details

It is recommended to have an `etpHandler` or similiar Stream Service within your System that initializes the interacts with the `ETP_v1_1` library. Below details the different interfaces included with the `ETP_v1_1` library.

### Initializing Library

```javascript
var etp = ETP_v1_1(etpOptions);
```

The etpOptions object is an optional set of configuration options for the Library. Currently they are used specifically for configuring auto creation of a Log Dataobject on Streaming Data Start, see that section for details on the options that can be provided.

### Connect

```javascript
function onDisconnect(reason) {
  resp.error("ETP disconnected: " + reason);
}

try {
  etp.Connect("wss://my.etp.server", "username", "password", onDisconnect);
} catch (e) {
  console.log("Failed to connect Websockets: " + e);
  resp.error(e);
}
```

You must call the above `Connect` function before using any other features documented below. If needed you can also add custom reconnect logic in the `onDisconnect` callback, the above example simply stops the stream service with the provided disconnect error.

### Discovery

```javascript
try {
  var discoveryRefreshIntervalInMinutes = 30;
  etp.InitializeDiscovery(discoveryRefreshIntervalInMinutes);
} catch (e) {
  console.log("failed to init discovery: " + e);
  resp.error(e);
}
```

After calling the `InitializeDiscovery` function with your preferred refresh interval the library will discover all Wells, Wellbores, and Logs that are available on the ETP server. This data will be inserted into the 3 Collections initially configured. In addition this data .will be automatically refreshed by the ETP library at the interval provided

### Streaming Data

There are 2 interfaces to start streaming data from a specific log, a function on the ETP library, as well as a direct MQTT interface

#### StartStreamForLogUri Function

```javascript
try {
  var logUri =
    "eml://witsml14/well(" +
    wellUid +
    ")/wellbore(" +
    wellboreUid +
    ")/log(" +
    logUid +
    ")";
  etp.StartStreamForLogUri(logUri);
} catch (e) {
  console.log("failed to start stream for log uri: " + e);
}
```

#### MQTT Interface

To start stream data for a specific log, simply publish an MQTT message on the below request topic with the specificed structure. The library will publish a success/failed response on the response topic.

##### Request Structure

MQTT Topic - `etp/stream/request`  
Message Structure:

```json
{
  "logUid": "87286ef9-9a65-44ba-8a7a-53b453aa071d",
  "wellUid": "1be57e62-f906-4bc7-89ad-b13e73101735",
  "wellboreUid": "6174f133-cf99-40bf-a9b1-9ef7024ecf95",
  "command": "start"
}
```

##### Response Structure

MQTT Topic - `etp/stream/response`  
Message Structure:

```json
{
  "logUid": "87286ef9-9a65-44ba-8a7a-53b453aa071d",
  "wellUid": "1be57e62-f906-4bc7-89ad-b13e73101735",
  "wellboreUid": "6174f133-cf99-40bf-a9b1-9ef7024ecf95",
  "command": "start",
  "error": false,
  "reason: "" // will be included if error is true and include details on the failure
}
```

#### Incoming ETP Streaming Data Structure

After successfully starting streaming data from a specified log, the library will publish all incoming data via MQTT. All mnomonics included in the log file will be in the MQTT message as well.

The MQTT Topic structure will be:

`etp/stream/incoming/<well_uid>/<wellbore_uid>/<log_uid>`

Note that the `<well_uid>`, `<wellbore_uid>`, and `<log_uid>` in the above topic will be replaced with the actual UIDs. This configuration allows for a dedicated topic per data stream for processing as needed in your application.

The MQTT Message structure will be:

```json
[
  {
    "time": "2022-07-07T04:14:12.869Z",
    "BIT_RPM_AVG": {
      "units": "rev/s",
      "value": 1.3406
    },
    "BITDEP": {
      "units": "m",
      "value": 4528.52477
    },
    ...
  }
]
```

Note that it is possible that multiple timestamped messages can be included in a single MQTT message, so ensure your application handles this.

### Creating Log DataObject

```javascript
try {
    var wellUid = "asdf";
    var wellboreUid = "asdf";
    var logUid = "log-test";
    var logName = "LogTest";
    var mnemonics = [{
        mnemonic: "RigActivityCode",
        unit: "unitless",
        dataType: "long"
      },
      ...
    ]
    etp.CreateLogInStore(wellUid, wellboreUid, logUid, logName, mnemonics)
} catch (e) {
    console.log("Failed to create log in store: " + e);
}

```

The above function call will create a Log DataObject with the specified configuration, multiple mnemonics can be provided via the array.

### Auto Creation of Log DataObject on Streaming Data Start

```javascript
const etpOptions = {
    createDestinationLogOnStreamStart: true,
    destinationLogName: "MyLogName",
    destinationLogUid: "my-log-uid",
    destinationMnemonics: [{
        mnemonic: "RigActivityCode",
        unit: "unitless",
        dataType: "long"
    }, ...
    ]
};

var etp = ETP_v1_1(etpOptions);
```

You can enable auto log createion of a Log DataObject by providing the above options when initializing the ETP library. With these options set, then after successfully starting streaming data for a log, a new log will be created on the same well and wellbore, with the provided uid, name, and mnemonics.

### Writing to a Log DataObject

```javascript
var wellUid = "asdf";
var wellboreUid = "asdf";
var logUid = "log-test";
var dataToWrite = [
  {
    Time: "2022-06-19T04:24:58.869Z",
    RigActivityCode: 5,
  },
];
etp.WriteLogDataToStore(wellUid, wellboreUid, logUid, dataToWrite);
```

You can call the above function in order to write data to the specified log. You can write multiple mnemonics and timestamps at the same time via the dataToWrite array of objects.
