var misc = require("./misc"),
    defaults = require("./defaults"),
    handlers = require("./handlers"),
    fs = require("fs"),
    request = require("request"),
    queue = require("queue-async"),
    extend = require("extend"),
    util = require("util"),
    render = require("mustache").render,
    csv = require("./csv"),
    EventEmitter = require("events").EventEmitter;

module.exports = generate;

function generate(inFile,outFile,userOptions) {

  var input = inFile,
      output = null,
      options = {};

  if (arguments.length === 2) {
    if (typeof outFile === "string") {
      output = outFile;
    } else {
      options = outFile;
    }
  } else if (arguments.length === 3) {
    output = outFile;
    options = userOptions;
  }

  //Extend default options
  options = extend({},defaults,options);

  if (typeof options.handler === "string") {
    options.handler = options.handler.toLowerCase();
    if (handlers[options.handler]) {
      options.handler = handlers[options.handler];
    } else {
      throw new Error("Invalid value for 'handler' option.  Must be the name of a built-in handler or a custom handler.");
    }
  } else if (typeof options.handler !== "function") {
    throw new TypeError("Invalid value for 'handler' option.  Must be the name of a built-in handler or a custom handler.");
  }

  if (output && typeof output !== "string") {
    throw new TypeError("Invalid value for output.  Needs to be a string filename.");
  }

  if (typeof options.url !== "string") {
    throw new Error("'url' parameter is required.");
  }

  var geocoder = new Geocoder();

  return geocoder.run(input,output,options);

};

var Geocoder = function() {
};

util.inherits(Geocoder, EventEmitter);

Geocoder.prototype.run = function(input,output,options) {

  var cache = {}, //Cached results by address
      _this = this,
      time = (new Date()).getTime();

  this.options = options;

  csv.read(input,csvParsed);

  return this;

  function csvParsed(parsed) {

    var q = queue(1);

    //If there are unset column names,
    //try to discover them on the first data row
    if (options.lat === null || options.lng === null) {

      options = misc.discoverOptions(options,parsed[0]);

    }

    parsed.forEach(function(row){
      q.defer(codeRow,row);
    });

    q.awaitAll(complete);

  }

  function codeRow(row,cb) {

    var url = render(options.url,escape(row));

    //Doesn't need geocoding
    if (!options.force && misc.isNumeric(row[options.lat]) && misc.isNumeric(row[options.lng])) {
      _this.emit("row",null,row);
      return cb(null,row);
    }

    //Address is cached from a previous result
    if (cache[url]) {

      row[options.lat] = cache[url].lat;
      row[options.lng] = cache[url].lng;

      _this.emit("row",null,row);
      return cb(null,row);

    }

    request.get(url,function(err,response,body) {
    
      //Some other error
      if (err) {

        _this.emit("row",err.toString(),row);
        return cb(null,row);

      } else if (response.statusCode !== 200) {

        _this.emit("row","HTTP Status "+response.statusCode,row);
        return cb(null,row);

      } else {

        handleResponse(body,row,url,cb);

      }

    });

  }


  function handleResponse(body,row,url,cb) {

    var result;
    let geoAddressBody;
    try {
      result = options.handler(body);
      geoAddressBody = JSON.parse(body);
    } catch (e) {
      _this.emit("row","Parsing error: "+e.toString(),row);
    }

    //Error code
    if (typeof result === "string") {
      row[options.lat] = "";
      row[options.lng] = "";

      _this.emit("row",result,row);

    //Success
    } else if ("lat" in result && "lng" in result) {
      
      let location = {};
      location.coordinates = [result.lng, result.lat];
      if(geoAddressBody) {
        location.formattedAddress = geoAddressBody.results[0].formatted_address;
        geoAddressBody.results[0].address_components.forEach(addressItem => {
          if (addressItem['types'] && addressItem['types']['0'] === 'postal_code') {
            location.postalCode = addressItem['long_name'] ? addressItem['long_name'] : '';
          }
          if (addressItem['types'] && addressItem['types']['0'] === 'country') {
            location.country = addressItem['long_name'] ? addressItem['long_name'] : '';
          }
          if (addressItem['types'] && addressItem['types']['0'] === 'administrative_area_level_1') {
            location.region = addressItem['long_name'] ? addressItem['long_name'] : '';
          }
          if (addressItem['types'] && addressItem['types']['0'] === 'administrative_area_level_2') {
            location.locality = addressItem['long_name'] ? addressItem['long_name'] : '';
          }
        });
      }
      row[options.lat] = result.lat;
      row[options.lng] = result.lng;
      row[options.location] = location;

      //Cache the result
      cache[url] = result;
      _this.emit("row",null,row);

    //Unknown extraction error
    } else {
      _this.emit("row","Invalid return value from handler for response body: "+body,row);

    }

    return setTimeout(function(){
      cb(null,row);
    },options.delay);

  }


  function complete(e,results) {

    var numSuccesses = results.filter(successful).length,
        numFailures = results.length - numSuccesses,
        summarize = function(){
          _this.emit("complete",{
            failures: numFailures,
            successes: numSuccesses,
            time: (new Date()).getTime() - time
          });
        };

    if (!options.test) {

      if (typeof output === "string") {

        csv.write(output,results,summarize);

      } else {

        output = output || process.stdout;

        try {

          output.write(csv.stringify(results),summarize);

        } catch(e) {

          throw new TypeError("Second argument output needs to be a filename or a writeable stream.");

        }

      }

    } else {
      summarize();
    }

  }

  function successful(row) {
    return misc.isNumeric(row[options.lat]) && misc.isNumeric(row[options.lng]);
  }

  function escape(row) {
    var escaped = extend({},row);

    for (var key in escaped) {
      escaped[key] = encodeURIComponent(escaped[key]).replace(/(%20| )/g,"+").replace(/[&]/g,"%26");
    }

    return escaped;
  }

};

