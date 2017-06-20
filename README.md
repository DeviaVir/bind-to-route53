# bind-to-route53

[![Greenkeeper badge](https://badges.greenkeeper.io/DeviaVir/bind-to-route53.svg)](https://greenkeeper.io/)
BIND DNS to Route53

This utility has been used to move all DualDev DNS domains to AWS Route53 in a matter of a few minutes. For any specific rules used for DualDev, please see the `dualdev` branch.

### Example usage

```
node export.js -v -k XXXXXXXXXXXXXXXXXXXX -s xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx -r eu-west-1 -i /etc/named/
```

### Errors

If any errors occur, the ".db" files are still in the folder, please note the AWS API is extremely strict, so any wrongly configured ".db" files could stop the entire process. Then there is also an unknown rate limit in place on the `hostedZone`, which will sometimes come and bite you in the ass (this limit will be hit faster when there are errors).