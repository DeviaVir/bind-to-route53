#!/usr/bin/node
/**
 * Required modules
 */
var fs = require('fs'),
    cli = require('cli'),
    Promise = require('bluebird'),
    AWS = require('aws-sdk'),
    bind = require('dns-zonefile'),
    region;

/** Parse CLI commands */
cli.parse({
  log: ['v', 'Enable verbose logging'],
  awsKey: ['k', 'AWS access key (IAM user must have policy access to Route 53)', 'string'],
  awsSecret: ['s', 'AWS access secret (IAM user must have policy access to Route 53)', 'string'],
  awsRegion: ['r', 'AWS region', 'string', 'us-west-1'],
  input: ['i', 'Folder that holds all of the "*.db" files', 'path', '/var/named/']
});

/** Main process */
cli.main(function(args, options) {
  /** Overwrite console.log with a fake function when debug is false */
  if(!options.log) {
    console.log = function log() { return false; };
  }
  console.log('Input options', options);

  var _self = this;

  if(options.awsKey === null || options.awsSecret === null || options.awsRegion === null) {
    _self.fatal('Please supply awsKey, awsSecret and awsRegion (IAM user must have policy access to Route 53)');
  }

  /** AWS config setup */
  region = options.awsRegion;
  AWS.config.update({accessKeyId: options.awsKey, secretAccessKey: options.awsSecret, region: region});
  
  /** Check if path ends on "/" */
  if(options.input.substr(options.input - 1) != '/') {
    options.input += '/';
  }

  /** Loop through path to find domains */
  var domains = [];

  Promise.promisify(fs.readdir)(options.input).then(function(list) {
    return Promise.resolve(list).each(function(file) {
      if(file.substr(file.length - 3) == '.db')
        return domains.push(file);

      console.log('Skipping file', file);
    });
  }).catch(function(err) {
    console.log(err);
    _self.fatal('Reading input directory failed');
    process.exit();
  }).then(function() {
    var total = domains.length, i = 0;
    return Promise.resolve(domains).each(function(domain) {
      console.log(domain);
      return Promise.promisify(processDomain)(options.input, domain).then(function(result) {
        if(result === true)
          cli.progress(++i / total);
      }).catch(function(err) {
        _self.fatal(err.message);
        process.exit();
      });
    }).then(function() {
      return cli.ok('Finished!');
    });
  }).finally(function() {
    /** Kill the node */
    process.exit();
  });
});

var processDomain = function processDomain(path, file, fn) {
  var domain = file.substr(0, (file.length - 3)),
      zone = fs.readFileSync(path + file, 'utf8');

  var params = {
    CallerReference: 'NS_Migration_01', /* required */
    Name: domain, /* required */
    HostedZoneConfig: {
      Comment: 'Migrated'
    }
  };

  new AWS.Route53().createHostedZone(params, function(err, data) {
    if(err) {
      if(err.code == 'HostedZoneAlreadyExists') {
        console.log('This domain already exists in Route53');
        return fn(null, true);
      }
      console.log(err);
      return fn({'message': 'Check your AWS IAM user'}, false);
    }

    if(!('HostedZone' in data) || !('Id' in data.HostedZone))
      return fn({'message': 'Required data not returned by AWS, please contact the publisher of this utility'}, false);

    var zoneId = data.HostedZone.Id;
    parseBind(domain, bind.parse(zone), function(changes) {
      if(changes === false) {
        return fn({'message': 'The bind file could not be parsed: ' + domain}, false);
      }

      var params = {
        HostedZoneId: zoneId,
        ChangeBatch: {
          Changes: changes
        }
      };

      new AWS.Route53().changeResourceRecordSets(params, function(err, data) {
        if(err) {
          console.log(err);
          return fn({'message': 'Something went wrong while setting DNS records'}, false);
        }
        return fn(null, true);
      });
    });
  });
};

var parseBind = function parseBind(domain, bind, cb) {
  if(typeof bind !== 'object')
    return cb(false);

  var changes = [],
      setTempl = {
    'Action': 'CREATE',
    'ResourceRecordSet': {
      'Name': '',
      'Type': '',
      'TTL': '',
      'ResourceRecords': []
    }
  };

  var records = {
    'a': {},
    'aaaa': {},
    'srv': {},
    'ptr': {},
    'txt': {},
    'mx': {}
  }, obj;
  
  return Promise.resolve(Object.keys(bind)).each(function(type) {
    switch(type) {
      case 'a':
      case 'aaaa':
      case 'srv':
      case 'ptr':
        Promise.resolve(bind[(type)]).each(function(value) {
          if(value.name.indexOf(domain) < 0)
            value.name += '.' + domain;
          if(value.name.substr(-1) != '.')
            value.name += '.';

          if(value.ip.indexOf('all') < 0) {
            if(value.name in records[(type)]) {
              records[(type)][(value.name)].ips.push(value.ip);
            }
            else {
              obj = {
                name: value.name,
                ttl: value.ttl,
                ips: [
                  value.ip
                ]
              };
              records[(type)][(value.name)] = obj;
            }
          }
        });
      break;
      case 'txt':
        Promise.resolve(bind[(type)]).each(function(value) {
          if(value.name.indexOf(domain) < 0)
            value.name += '.' + domain;
          if(value.name.substr(-1) != '.')
            value.name += '.';

          if(value.name in records[(type)]) {
            records[(type)][(value.name)].txts.push(value.txt);
          }
          else {
            obj = {
              name: value.name,
              ttl: value.ttl,
              txts: [
                value.txt
              ]
            };
            records[(type)][(value.name)] = obj;
          }
        });
      break;
      case 'mx':
        Promise.resolve(bind[(type)]).each(function(value) {
          if(value.name.indexOf(domain) < 0)
            value.name += '.' + domain;
          if(value.name.substr(-1) != '.')
            value.name += '.';

          if(value.name in records[(type)]) {
            records[(type)][(value.name)].mxs.push(value.preference + ' ' + value.host);
          }
          else {
            obj = {
              name: value.name,
              ttl: value.ttl,
              mxs: [
                value.preference + ' ' + value.host
              ]
            };
            records[(type)][(value.name)] = obj;
          }
        });
      break;
    }
  }).then(function() {
    return Promise.resolve(Object.keys(records)).each(function(type) {
      switch(type) {
        case 'a':
        case 'aaaa':
        case 'srv':
        case 'ptr':
          return Promise.resolve(Object.keys(records[(type)])).each(function(value) {
            value = records[(type)][(value)];

            var set = JSON.parse(JSON.stringify(setTempl));
            set['ResourceRecordSet']['Name'] = value.name;
            set['ResourceRecordSet']['Type'] = type.toUpperCase();
            set['ResourceRecordSet']['TTL']  = value.ttl;

            value.ips.forEach(function(ip) {
              set['ResourceRecordSet']['ResourceRecords'].push({
                'Value': ip
              });
            });

            changes.push(set);
          });
        case 'txt':
          return Promise.resolve(Object.keys(records[(type)])).each(function(value) {
            value = records[(type)][(value)];

            var set = JSON.parse(JSON.stringify(setTempl));
            set['ResourceRecordSet']['Name'] = value.name;
            set['ResourceRecordSet']['Type'] = type.toUpperCase();
            set['ResourceRecordSet']['TTL']  = value.ttl;

            value.txts.forEach(function(txt) {
              set['ResourceRecordSet']['ResourceRecords'].push({
                'Value':  '"' + txt + '"'
              });
            });

            changes.push(set);
          });
        case 'mx':
          return Promise.resolve(Object.keys(records[(type)])).each(function(value) {
            value = records[(type)][(value)];

            var set = JSON.parse(JSON.stringify(setTempl));
            set['ResourceRecordSet']['Name'] = value.name;
            set['ResourceRecordSet']['Type'] = type.toUpperCase();
            set['ResourceRecordSet']['TTL']  = value.ttl;

            value.mxs.forEach(function(mx) {
              set['ResourceRecordSet']['ResourceRecords'].push({
                'Value': mx
              });
            });

            changes.push(set);
          });
      }
    });
  }).finally(function() {
    return cb(changes);
  });
};