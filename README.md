# ETP_v1_1 library

## Overview

The ETP_v1_1.js library can be added to your ClearBlade system to provide an easy interface to an ETP server running v1.1. This library currently supports discovery, streaming data, creating, and writing data objects to the store.

## Prerequisite

Currently, this library expects a few existing system collections. See below for their names and required data structures.

### etp_v1_1_logs

| Column name          | Column type | Index   | Unique index |
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

| Column name          | Column type | Index   | Unique index |
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

| Column name          | Column type | Index   | Unique index |
| -------------------- | ----------- | ------- | ------------ |
| uid                  | string      |         |              |
| uri                  | string      | &check; | &check;      |
| name                 | string      |         |              |
| custom_data          | jsonb       |         |              |
| last_updated         | timestamp   |         |              |
| last_changed         | timestamp   |         |              |
| object_notifiable    | bool        |         |              |
| channel_subscribable | bool        |         |              |

## API details

An `etpHandler` or similar stream service is recommended to initialize the `ETP_v1_1` library's interactions. Below are details of the different interfaces included with the `ETP_v1_1` library.

### Initializing library

```javascript
var etp = ETP_v1_1(etpOptions);
```

The etpOptions object is an optional set of configuration options for the library. They are used specifically for configuring the auto-creation of a log data object on streaming data start. See that section for details on the options that can be provided.

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

You must call the above `Connect` function before using any other features documented below. You can also add custom reconnect logic in the `onDisconnect` callback if needed. The above example stops the stream service with the provided disconnect error.

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

After calling the `InitializeDiscovery` function with your preferred refresh interval, the library will discover all wells, wellbores, and logs available on the ETP server. This data will be inserted into the three collections initially configured. In addition, this data will be automatically refreshed by the ETP library at the interval provided

### Streaming data

There are two interfaces to start streaming data from a specific log, an ETP library function, and a direct MQTT interface.

#### StartStreamForLogUri function

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

#### MQTT interface

To start stream data for a specific log, publish an MQTT message on the below request topic with the specified structure. The library will publish a success/failed response on the response topic.

##### Request structure

MQTT topic: `etp/stream/request`  
Message structure:

```json
{
  "logUid": "87286ef9-9a65-44ba-8a7a-53b453aa071d",
  "wellUid": "1be57e62-f906-4bc7-89ad-b13e73101735",
  "wellboreUid": "6174f133-cf99-40bf-a9b1-9ef7024ecf95",
  "command": "start"
}
```

##### Response structure

MQTT topic: `etp/stream/response`  
Message structure:

```json
{
  "logUid": "87286ef9-9a65-44ba-8a7a-53b453aa071d",
  "wellUid": "1be57e62-f906-4bc7-89ad-b13e73101735",
  "wellboreUid": "6174f133-cf99-40bf-a9b1-9ef7024ecf95",
  "command": "start",
  "error": false,
  "reason: "" // will be included if the error is true and include failure details
}
```

#### Incoming ETP streaming data structure

After successfully starting streaming data from a specified log, the library will publish all incoming data via MQTT. All mnemonics included in the log file will also be in the MQTT message.

The MQTT topic structure will be:

`etp/stream/incoming/<well_uid>/<wellbore_uid>/<log_uid>`

The `<well_uid>`, `<wellbore_uid>`, and `<log_uid>` in the above topic will be replaced with the actual UIDs. This configuration allows for a dedicated topic per data stream for processing as needed in your application.

The MQTT message structure will be:

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

It is possible that multiple timestamped messages can be included in a single MQTT message, so ensure your application handles this.

### Creating log data object

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

The above function call will create a log data object with the specified configuration, and multiple mnemonics can be provided via the array.

### Auto-creation of log data object on streaming data start

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

You can enable auto log creation of a log data object by providing the above options when initializing the ETP library. With these options set, then after successfully starting streaming data for a log, a new log will be created on the same well and wellbore, with the provided uid, name, and mnemonics.

### Writing to a log data object

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

You can call the above function to write data to the specified log. You can write multiple mnemonics and timestamps at the same time via the dataToWrite array of objects.
