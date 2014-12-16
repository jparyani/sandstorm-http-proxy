// A proxy for transforming HTTP requests into the appropriate Sandstorm capibilities

var url = require('url'),
    http = require('http'),
    https = require('https'),
    capnp = require('capnp'),
    Promise = require("es6-promise").Promise;

var HackSessionContext = capnp.importSystem("sandstorm/hack-session.capnp").HackSessionContext,
    ByteStream = capnp.importSystem("sandstorm/util.capnp").ByteStream,
    WebSession = capnp.importSystem("sandstorm/web-session.capnp").WebSession;

var sendError = function (err, response) {
  if (response.headersSent) {
    console.error('Too late to send error');
  } else {
    response.writeHead(500, "Internal Server Error", { "Content-Type": "text/plain" });
  }
  console.error(err);
  response.end(err);
};

// Lifted from Sandstorm

// TODO(cleanup):  Auto-generate based on annotations in web-session.capnp.
var successCodes = {
  ok:       { id: 200, title: "OK" },
  created:  { id: 201, title: "Created" },
  accepted: { id: 202, title: "Accepted" }
};
var noContentSuccessCodes = [
  // Indexed by shouldResetForm * 1
  { id: 204, title: "No Content" },
  { id: 205, title: "Reset Content" }
];
var redirectCodes = [
  // Indexed by switchToGet * 2 + isPermanent
  { id: 307, title: "Temporary Redirect" },
  { id: 308, title: "Permanent Redirect" },
  { id: 303, title: "See Other" },
  { id: 301, title: "Moved Permanently" }
];
var errorCodes = {
  badRequest:            { id: 400, title: "Bad Request" },
  forbidden:             { id: 403, title: "Forbidden" },
  notFound:              { id: 404, title: "Not Found" },
  methodNotAllowed:      { id: 405, title: "Method Not Allowed" },
  notAcceptable:         { id: 406, title: "Not Acceptable" },
  conflict:              { id: 409, title: "Conflict" },
  gone:                  { id: 410, title: "Gone" },
  requestEntityTooLarge: { id: 413, title: "Request Entity Too Large" },
  requestUriTooLong:     { id: 414, title: "Request-URI Too Long" },
  unsupportedMediaType:  { id: 415, title: "Unsupported Media Type" },
  imATeapot:             { id: 418, title: "I'm a teapot" },
};

function ResponseStream(response, streamHandle, resolve, reject) {
  this.response = response;
  this.streamHandle = streamHandle;
  this.resolve = resolve;
  this.reject = reject;
  this.ended = false;
}

ResponseStream.prototype.write = function (data) {
  this.response.write(data);
}

ResponseStream.prototype.done = function () {
  this.response.end();
  this.streamHandle.close();
  this.ended = true;
}

ResponseStream.prototype.close = function () {
  if (this.ended) {
    this.resolve();
  } else {
    this.streamHandle.close();
    this.reject(new Error("done() was never called on outbound stream."));
  }
}

var makeContext = function (request, response) {
  var context = {};

  var promise = new Promise(function (resolve, reject) {
    response.resolveResponseStream = resolve;
    response.rejectResponseStream = reject;
  });

  context.responseStream = new capnp.Capability(promise, ByteStream);

  return context;
}

var translateResponse = function (rpcResponse, response) {
  // This is an API request. Cookies are not supported.

  // We need to make sure caches know that different bearer tokens get totally different results.
  response.setHeader("Vary", "Authorization");

  // APIs can be called from any origin. Because we ignore cookies, there is no security problem.
  response.setHeader("Access-Control-Allow-Origin", "*");

  // Add a Content-Security-Policy as a backup in case someone finds a way to load this resource
  // in a browser context. This policy should thoroughly neuter it.
  response.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");

  // TODO(security): Set X-Content-Type-Options: nosniff?

  if ("content" in rpcResponse) {
    var content = rpcResponse.content;
    var code = successCodes[content.statusCode];
    if (!code) {
      throw new Error("Unknown status code: ", content.statusCode);
    }

    if (content.mimeType) {
      response.setHeader("Content-Type", content.mimeType);
    }
    if (content.encoding) {
      response.setHeader("Content-Encoding", content.encoding);
    }
    if (content.language) {
      response.setHeader("Content-Language", content.language);
    }
    if (("disposition" in content) && ("download" in content.disposition)) {
      response.setHeader("Content-Disposition", "attachment; filename=\"" +
          content.disposition.download.replace(/([\\"\n])/g, "\\$1") + "\"");
    }
    if ("stream" in content.body) {
      var streamHandle = content.body.stream;
      response.writeHead(code.id, code.title);
      var promise = new Promise(function (resolve, reject) {
        response.resolveResponseStream(new Capnp.Capability(
            new ResponseStream(response, streamHandle, resolve, reject), ByteStream));
      });
      promise.streamHandle = streamHandle;
      return promise;
    } else {
      // response.rejectResponseStream(
      //   new Error("Response content body was not a stream."));

      if ("bytes" in content.body) {
        response.setHeader("Content-Length", content.body.bytes.length);
      } else {
        throw new Error("Unknown content body type.");
      }
    }

    response.writeHead(code.id, code.title);

    if ("bytes" in content.body) {
      response.end(content.body.bytes);
    }
  } else if ("noContent" in rpcResponse) {
    var noContent = rpcResponse.noContent;
    var noContentCode = noContentSuccessCodes[noContent.shouldResetForm * 1];
    response.writeHead(noContentCode.id, noContentCode.title);
    response.end();
  } else if ("redirect" in rpcResponse) {
    var redirect = rpcResponse.redirect;
    var redirectCode = redirectCodes[redirect.switchToGet * 2 + redirect.isPermanent];
    response.writeHead(redirectCode.id, redirectCode.title, {
      "Location": redirect.location
    });
    response.end();
  } else if ("clientError" in rpcResponse) {
    var clientError = rpcResponse.clientError;
    var errorCode = errorCodes[clientError.statusCode];
    if (!errorCode) {
      throw new Error("Unknown status code: ", clientError.statusCode);
    }
    response.writeHead(errorCode.id, errorCode.title, {
      "Content-Type": "text/html"
    });
    if (clientError.descriptionHtml) {
      response.end(clientError.descriptionHtml);
    } else {
      // TODO(someday):  Better default error page.
      response.end("<html><body><h1>" + errorCode.id + ": " + errorCode.title +
                   "</h1></body></html>");
    }
  } else if ("serverError" in rpcResponse) {
    response.writeHead(500, "Internal Server Error", {
      "Content-Type": "text/html"
    });
    if (rpcResponse.serverError.descriptionHtml) {
      response.end(rpcResponse.serverError.descriptionHtml);
    } else {
      // TODO(someday):  Better default error page.
      response.end("<html><body><h1>500: Internal Server Error</h1></body></html>");
    }
  } else {
    throw new Error("Unknown HTTP response type:\n" + JSON.stringify(rpcResponse));
  }

  return Promise.resolve(undefined);
}

var PORT = process.argv[2] || 30080;

var connection = capnp.connect("unix:/tmp/sandstorm-api");
var hackSession = connection.restore("HackSessionContext", HackSessionContext);
var apiEndpointPromise = hackSession.getApiEndpoint();

var server = http.createServer(function(request, response) {
  return apiEndpointPromise.then(function(endpoint) {
    var reqUrl = request.url;
    reqUrl = reqUrl.replace(/\/$/, ''); // strip trailing /

    var parsedUrl = url.parse(reqUrl),
        path = parsedUrl.path;

    console.log(reqUrl, endpoint);

    endpointUrl = endpoint.endpointUrl;
    if (reqUrl === endpointUrl) {
      // TODO: parse token out of headers
      var session = new capnp.Capability(hackSession.getUIViewForToken("").session, WebSession);
      var context = makeContext();
      var resultPromise;

      if (request.method === "GET") {
        resultPromise = session.get(path, context);
      } else if (request.method === "POST") {
        // TODO: change to streaming
        resultPromise = session.post(path, {
          mimeType: request.headers["content-type"] || "application/octet-stream",
          content: data
        }, context);
      } else if (request.method === "PUT") {
        resultPromise = session.put(path, {
          mimeType: request.headers["content-type"] || "application/octet-stream",
          content: data
        }, context);
      } else if (request.method === "DELETE") {
        resultPromise = session.delete(path, context);
      } else {
        response.writeHead(500, "Internal Server Error", { "Content-Type": "text/plain" });
        var message = "Sandstorm only supports GET, POST, PUT, and DELETE requests.";
        response.end(message);
        console.error(message);
        return;
      }
      return resultPromise.then(function (rpcResponse) {
        return translateResponse(rpcResponse, response);
      }).catch(function(err) {
        sendError(err, response);
      });

    } else {
      // TODO: allow headers and add methods other than httpGet
      if (request.method === "GET") {
        // TODO: passthrough http status code?
        return hackSession.httpGet(reqUrl).then(function (httpResult) {
          response.writeHead(200, "OK", { "Content-Type": httpResult.mimeType });
          response.end(httpResult.content);
        }).catch(function(err) {
          sendError(err, response);
        });
      } else {
        response.writeHead(500, "Internal Server Error", { "Content-Type": "text/plain" });
        var message = "Only GET is supported at the moment for external requests";
        response.end(message);
        console.error(message);
      }
    }
  }).catch(function(err) {
    sendError(err, response);
  })
});

console.log('sandstorm-http-proxy listening on http://localhost:%s...', PORT);
server.listen(PORT);
