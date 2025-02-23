"use strict";

const mongoose = require('mongoose')
  , async = require("async")
  , moment = require('moment')
  , Token = require('./token')
  , Login = require('./login')
  , Event = require('./event')
  , Team = require('./team')
  , Observation = require('./observation')
  , Location = require('./location')
  , CappedLocation = require('./cappedLocation')
  , Authentication = require('./authentication')
  , AuthenticationConfiguration = require('./authenticationconfiguration')
  , { pageQuery } = require('../adapters/base/adapters.base.db.mongoose')
  , { pageOf } = require('../entities/entities.global')
  , FilterParser = require('../utilities/filterParser');

// Creates a new Mongoose Schema object
const Schema = mongoose.Schema;

const PhoneSchema = new Schema({
  type: { type: String, required: true },
  number: { type: String, required: true }
}, {
  versionKey: false,
  _id: false
});

// Collection to hold users
const UserSchema = new Schema(
  {
    username: { type: String, required: true, unique: true },
    displayName: { type: String, required: true },
    email: { type: String, required: false },
    phones: [PhoneSchema],
    avatar: {
      contentType: { type: String, required: false },
      size: { type: Number, required: false },
      relativePath: { type: String, required: false }
    },
    icon: {
      type: { type: String, enum: ['none', 'upload', 'create'], default: 'none' },
      text: { type: String },
      color: { type: String },
      contentType: { type: String, required: false },
      size: { type: Number, required: false },
      relativePath: { type: String, required: false }
    },
    active: { type: Boolean, required: true },
    enabled: { type: Boolean, default: true, required: true },
    roleId: { type: Schema.Types.ObjectId, ref: 'Role', required: true },
    status: { type: String, required: false, index: 'sparse' },
    recentEventIds: [{ type: Number, ref: 'Event' }],
    authenticationId: { type: Schema.Types.ObjectId, ref: 'Authentication', required: true }
  },
  {
    versionKey: false,
    timestamps: {
      updatedAt: 'lastUpdated'
    },
    toObject: {
      transform: DbUserToObject
    },
    toJSON: {
      transform: DbUserToObject
    }
  }
);

UserSchema.virtual('authentication').get(function () {
  return this.populated('authenticationId') ? this.authenticationId : null;
});

// Lowercase the username we store, this will allow for case insensitive usernames
// Validate that username does not already exist
UserSchema.pre('save', function (next) {
  const user = this;
  user.username = user.username.toLowerCase();
  this.model('User').findOne({ username: user.username }, function (err, possibleDuplicate) {
    if (err) return next(err);

    if (possibleDuplicate && !possibleDuplicate._id.equals(user._id)) {
      const error = new Error('username already exists');
      error.status = 409;
      return next(error);
    }

    next();
  });
});

UserSchema.pre('save', function (next) {
  const user = this;
  if (user.active === false || user.enabled === false) {
    Token.removeTokensForUser(user, function (err) {
      next(err);
    });
  } else {
    next();
  }
});

UserSchema.pre('remove', function (next) {
  const user = this;

  async.parallel({
    location: function (done) {
      Location.removeLocationsForUser(user, done);
    },
    cappedlocation: function (done) {
      CappedLocation.removeLocationsForUser(user, done);
    },
    token: function (done) {
      Token.removeTokensForUser(user, done);
    },
    login: function (done) {
      Login.removeLoginsForUser(user, done);
    },
    observation: function (done) {
      Observation.removeUser(user, done);
    },
    eventAcl: function (done) {
      Event.removeUserFromAllAcls(user, function (err) {
        done(err);
      });
    },
    teamAcl: function (done) {
      Team.removeUserFromAllAcls(user, done);
    },
    authentication: function (done) {
      Authentication.removeAuthenticationById(user.authenticationId, done);
    }
  },
    function (err) {
      next(err);
    });
});

// eslint-disable-next-line complexity
function DbUserToObject(user, userOut, options) {
  if ('function' === typeof user.ownerDocument) {
    return void(0);
  }
  userOut.id = userOut._id;
  delete userOut._id;

  delete userOut.avatar;

  if (userOut.icon) { // TODO remove if check, icon is always there
    delete userOut.icon.relativePath;
  }

  if (user.populated('roleId')) {
    userOut.role = userOut.roleId;
    delete userOut.roleId;
  }

  /*
  TODO: this used to use user.populated('authenticationId'), but when paging
  and using the cursor(), mongoose was not setting the populated flag on the
  cursor documents, so this condition was never met and paged user documents
  erroneously retained the authenticationId key with the populated
  authentication object.  this occurs in mage server 6.2.x with mongoose 4.x.
  this might be fixed in mongoose 5+, so revisit on mage server 6.3.x.
  */
  if (!!user.authenticationId && typeof user.authenticationId.toObject === 'function') {
    const authPlain = user.authenticationId.toObject({ virtuals: true });
    delete userOut.authenticationId;
    userOut.authentication = authPlain;
  }

  if (user.avatar && user.avatar.relativePath) {
    // TODO, don't really like this, need a better way to set user resource, route
    userOut.avatarUrl = [(options.path ? options.path : ""), "api", "users", user._id, "avatar"].join("/");
  }

  if (user.icon && user.icon.relativePath) {
    // TODO, don't really like this, need a better way to set user resource, route
    userOut.iconUrl = [(options.path ? options.path : ""), "api", "users", user._id, "icon"].join("/");
  }

  return userOut;
};

exports.transform = DbUserToObject;

// Creates the Model for the User Schema
const User = mongoose.model('User', UserSchema);
exports.Model = User;

exports.getUserById = function (id, callback) {
  let result = User.findById(id).populate('roleId').populate({ path: 'authenticationId', populate: { path: 'authenticationConfigurationId' } });
  if (typeof callback === 'function') {
    result = result.then(
      user => {
        callback(null, user);
      },
      err => {
        callback(err);
      });
  }
  return result;
};

exports.getUserByUsername = function (username, callback) {
  User.findOne({ username: username.toLowerCase() }).populate('roleId').populate({ path: 'authenticationId', populate: { path: 'authenticationConfigurationId' } }).exec(callback);
};

exports.getUserByAuthenticationId = function (id) {
  return User.findOne({ authenticationId: id }).populate({ path: 'authenticationId', populate: { path: 'authenticationConfigurationId' } }).exec();
}

exports.getUserByAuthenticationStrategy = function (strategy, uid, callback) {
  Authentication.getAuthenticationByStrategy(strategy, uid, function (err, authentication) {
    if (err || !authentication) return callback(err);

    User.findOne({ authenticationId: authentication._id }).populate('roleId').populate({ path: 'authenticationId', populate: { path: 'authenticationConfigurationId' } }).exec(callback);
  });
}

function createQueryConditions(filter) {
  const conditions = FilterParser.parse(filter);

  if (filter.active) {
    conditions.active = filter.active == 'true';
  }
  if (filter.enabled) {
    conditions.enabled = filter.enabled == 'true';
  }

  return conditions;
};

exports.count = function (options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }

  options = options || {};
  const filter = options.filter || {};

  const conditions = createQueryConditions(filter);

  User.count(conditions, function (err, count) {
    callback(err, count);
  });
};

exports.getUsers = async function (options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }

  options = options || {};
  const filter = options.filter || {};

  const conditions = createQueryConditions(filter);

  let baseQuery = User.find(conditions).populate({ path: 'authenticationId', populate: { path: 'authenticationConfigurationId' } });

  if (options.lean) {
    baseQuery = baseQuery.lean();
  }

  if (options.populate && (options.populate.indexOf('roleId') !== -1)) {
    baseQuery = baseQuery.populate('roleId');
  }

  const isPaging = options.limit != null && options.limit > 0;
  if (isPaging) {
    const limit = Math.abs(options.limit) || 10;
    const start = (Math.abs(options.start) || 0);
    const page = Math.ceil(start / limit);

    const which = {
      pageSize: limit,
      pageIndex: page,
      includeTotalCount: true
    };
    try {
      const counted = await pageQuery(baseQuery, which);
      const users = [];
      for await (const userDoc of counted.query.cursor()) {
        users.push(entityForDocument(userDoc));
      }
      const pageof = pageOf(users, which, counted.totalCount);
      callback(null, users, pageof);
    } catch (err) {
      callback(err);
    }
  } else {
    baseQuery.exec(function (err, users) {
      callback(err, users, null);
    });
  }
};

function entityForDocument(doc) {
  const json = doc.toJSON();
  const entity = {
    ...json,
    id: doc._id.toHexString()
  }

  return entity;
}

exports.createUser = function (user, callback) {
  Authentication.createAuthentication(user.authentication).then(authentication => {
    const newUser = {
      username: user.username,
      displayName: user.displayName,
      email: user.email,
      phones: user.phones,
      active: user.active,
      roleId: user.roleId,
      avatar: user.avatar,
      icon: user.icon,
      authenticationId: authentication._id
    };

    User.create(newUser, function (err, user) {
      if (err) return callback(err);

      user.populate({ path: 'roleId', path: 'authenticationId', populate: { path: 'authenticationConfigurationId' } }, function (err, user) {
        callback(err, user);
      });
    });
  }).catch(err => callback(err));
};

exports.updateUser = function (user, callback) {
  user.save(function (err, user) {
    if (err) return callback(err);

    user.populate({ path: 'roleId', path: 'authenticationId', populate: { path: 'authenticationConfigurationId' } }, function (err, user) {
      callback(err, user);
    });
  });
};

exports.deleteUser = function (user, callback) {
  user.remove(function (err, removedUser) {
    callback(err, removedUser);
  });
};

exports.invalidLogin = async function (user) {
  const local = await AuthenticationConfiguration.getConfiguration('local', 'local');
  const { accountLock = {} } = local.settings;

  if (!accountLock.enabled) return user;

  const authentication = user.authentication;
  const invalidLoginAttempts = authentication.security.invalidLoginAttempts + 1;
  if (invalidLoginAttempts >= accountLock.threshold) {
    const numberOfTimesLocked = authentication.security.numberOfTimesLocked + 1;
    if (numberOfTimesLocked >= accountLock.max) {
      user.enabled = false;
      await user.save();

      authentication.security = {};
    } else {
      authentication.security = {
        locked: true,
        numberOfTimesLocked: numberOfTimesLocked,
        lockedUntil: moment().add(accountLock.interval, 'seconds').toDate()
      };
    }
  } else {
    authentication.security.invalidLoginAttempts = invalidLoginAttempts;
    authentication.security.locked = undefined;
    authentication.security.lockedUntil = undefined;
  }

  await authentication.save();
};

exports.validLogin = async function (user) {
  user.authentication.security = {};
  await user.authentication.save();
};

exports.setStatusForUser = function (user, status, callback) {
  const update = { status: status };
  User.findByIdAndUpdate(user._id, update, { new: true }, function (err, user) {
    callback(err, user);
  });
};

exports.setRoleForUser = function (user, role, callback) {
  const update = { role: role };
  User.findByIdAndUpdate(user._id, update, { new: true }, function (err, user) {
    callback(err, user);
  });
};

exports.removeRolesForUser = function (user, callback) {
  const update = { roles: [] };
  User.findByIdAndUpdate(user._id, update, { new: true }, function (err, user) {
    callback(err, user);
  });
};

exports.removeRoleFromUsers = function (role, callback) {
  User.update({ role: role._id }, { roles: undefined }, function (err, number) {
    callback(err, number);
  });
};

exports.addRecentEventForUser = function (user, event, callback) {
  let eventIds = Array.from(user.recentEventIds);

  // push new event onto front of the list
  eventIds.unshift(event._id);

  // remove duplicates
  eventIds = eventIds.filter(function (eventId, index) {
    return eventIds.indexOf(eventId) === index;
  });

  // limit to 5
  if (eventIds.length > 5) {
    eventIds = eventIds.slice(0, 5);
  }

  User.findByIdAndUpdate(user._id, { recentEventIds: eventIds }, { new: true }, function (err, user) {
    callback(err, user);
  });
};

exports.removeRecentEventForUsers = function (event, callback) {
  const update = {
    $pull: { recentEventIds: event._id }
  };

  User.update({}, update, { multi: true }, function (err) {
    callback(err);
  });
};