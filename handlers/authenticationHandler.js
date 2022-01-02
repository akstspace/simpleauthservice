const crypto = require("crypto");
const { configs } = require("../configs");
const {
	confirmationEmailHelper,
	passwordChangedEmailAlert,
	sendNewLoginEmail,
	passwordResetEmailHelper,
} = require("../utils/services/sendEmail");
const {
	RefreshToken,
	getRefreshToken,
	revokeAllRfTokenByUser,
	getRftById,
} = require("../models/refreshToken");
const { User, hashPasswd } = require("../models/user");
const {
	sendErrorResponse,
	sendSuccessResponse,
	redirectWithToken,
} = require("../utils/responseHelpers");

// @route	POST /api/v1/auth/signup
// @desc	handler for registering user to database, returns
// 			jwt and refresh token
// @access	Public
const registerUser = async (request, reply) => {
	let { name, email, password } = request.body;

	// Check if there is an account with the same email
	const userExists = await User.findOne({
		email: email,
	});

	if (userExists) {
		return sendErrorResponse(reply, 400, "Duplicate field value entered");
	}

	let provider = "email";
	password = await hashPasswd(password);
	let role = "user";

	// Set Role to admin if no users exist
	if (configs.CHECK_ADMIN) {
		const count = await User.countDocuments();
		if (!count) {
			role = "admin";
		}
	}

	const user = await User.create({
		name,
		uid: crypto.randomBytes(15).toString("hex"),
		email,
		password,
		role,
		provider,
	});

	const confirmationToken = user.getEmailConfirmationToken();
	user.save({ validateBeforeSave: true });

	const refreshToken = await getRefreshToken(user, request.ipAddress);

	const emailStatus = await confirmationEmailHelper(
		user,
		request,
		confirmationToken
	);

	return sendSuccessResponse(
		reply,
		{
			statusCode: 201,
			message: "Sign up successful",
			token: user.getJWT(),
			emailSuccess: emailStatus.success,
			emailMessage: emailStatus.message,
		},
		{
			refreshToken,
		}
	);
};

// @route 	 POST /api/v1/auth/signin
// @desc	 Validates username and password and send a
//			 response with JWT and Refresh token
// @access 	 Public
const signin = async (request, reply) => {
	const { password } = request.body;
	const user = request.userModel;

	if (await user.matchPasswd(password)) {
		const refreshToken = await getRefreshToken(user, request.ipAddress);

		const emailStatus = await sendNewLoginEmail(user, request);

		return sendSuccessResponse(
			reply,
			{
				statusCode: 200,
				message: "Signed in",
				token: user.getJWT(),
				emailSuccess: emailStatus.success,
				emailMessage: emailStatus.message,
			},
			{
				refreshToken,
			}
		);
	} else {
		return sendErrorResponse(reply, 400, "Password Does not match");
	}
};

// @route 	GET /api/v1/auth/confirmEmail
// @desc	Endpoint to confirm the email of the user
// @access	Public (confirm email with the token . JWT is NOT required)
const confirmEmailTokenRedirect = async (request, reply) => {
	return redirectWithToken(reply, request.query.token, {
		redirectURL: configs.APP_CONFIRM_EMAIL_REDIRECT,
	});
};

// @route 	PUT /api/v1/auth/confirmEmail
// @desc 	Route to confirm email address with the token
// @access 	Public
const confirmEmail = async (request, reply) => {
	const user = request.userModel;
	user.confirmEmailToken = undefined;
	user.confirmEmailTokenExpire = undefined;
	user.isEmailConfirmed = true;
	user.save({ validateBeforeSave: false });

	return sendSuccessResponse(reply, {
		statusCode: 200,
		message: "Account successfully confirmed",
	});
};

// @route	POST /api/v1/auth/confirmEmail
// @desc	Request to send confirmation email again
// @access 	Public
const requestConfirmationEmail = async (request, reply) => {
	const user = request.userModel;
	if (user.isEmailConfirmed) {
		return sendErrorResponse(reply, 400, "Email already confirmed");
	}
	if (!user.isConfirmEmailTokenExpired()) {
		return sendErrorResponse(
			reply,
			400,
			"Confirmation email was recently sent to your email. Check Spam/Promotions folder.\
			 Please request again after some time."
		);
	}
	const confirmationToken = user.getEmailConfirmationToken();
	user.save({ validateBeforeSave: false });

	const emailStatus = await confirmationEmailHelper(
		user,
		request,
		confirmationToken
	);

	if (!emailStatus.success) {
		return sendErrorResponse(reply, 500, emailStatus.message);
	}

	return sendSuccessResponse(reply, {
		statusCode: 200,
		message: emailStatus.message,
		emailSuccess: emailStatus.success,
		emailMessage: emailStatus.message,
	});
};

// @route 	 POST /api/v1/auth/resetPassword
// @desc	 Request to send reset password email
// @access	 Public
const requestResetPasswordToken = async (request, reply) => {
	const user = request.userModel;

	if (!user.isPwResetTokenExpired()) {
		return sendErrorResponse(
			reply,
			400,
			"Please check your email, try again later"
		);
	}
	const pwResetToken = user.getPwResetToken();
	await user.save({ validateBeforeSave: false });

	const emailStatus = await passwordResetEmailHelper(
		user,
		request,
		pwResetToken
	);

	if (!emailStatus.success) {
		return sendErrorResponse(reply, 500, emailStatus.message);
	}

	return sendSuccessResponse(reply, {
		statusCode: 200,
		message: emailStatus.message,
		emailSuccess: emailStatus.success,
		emailMessage: emailStatus.message,
	});
};

// @route 	GET /api/v1/auth/resetPassword
// @desc  	This is executed when user clicks the link sent via email
//		  	verifies the token and redirects to frontend
// @access 	Public
const resetPasswordTokenRedirect = async (request, reply) => {
	return redirectWithToken(reply, request.query.token, {
		redirectURL: configs.APP_RESET_PASSWORD_REDIRECT,
	});
};

// @route 	PUT /api/v1/auth/resetPassword
// @desc 	Reset password from token (requested from frontend)
// @access	Public
const resetPasswordFromToken = async (request, reply) => {
	const user = request.userModel;
	let { password, confirmPassword } = request.body;
	if (password !== confirmPassword) {
		return sendErrorResponse(
			reply,
			400,
			"Password and confirmed password are different"
		);
	} else {
		await revokeAllRfTokenByUser(user, request.ipAddress);

		password = await hashPasswd(password);
		user.password = password;
		user.pwResetToken = undefined;
		user.pwResetExpire = undefined;
		user.save({ validateBeforeSave: true });

		const emailStatus = await passwordChangedEmailAlert(user, request);

		return sendSuccessResponse(reply, {
			statusCode: 200,
			message: "Password Updated",
			emailSuccess: emailStatus.success,
			emailMessage: emailStatus.message,
		});
	}
};

// @route  	PUT /api/v1/auth/updatePassword
// @desc 	Reset the password with current password when the user
//			user is logged in
// @access	Private (JWT TOKEN is required)
const updatePassword = async (request, reply) => {
	const user = request.userModel;
	const { currentPassword, password, confirmPassword } = request.body;
	const checkPassword = await user.matchPasswd(currentPassword);

	if (!checkPassword) {
		return sendErrorResponse(reply, 400, "Your entered the wrong password");
	}

	if (password !== confirmPassword) {
		return sendErrorResponse(
			reply,
			400,
			"Password and confirmed password are different"
		);
	}

	await revokeAllRfTokenByUser(user, request.ipAddress);

	user.password = await hashPasswd(password);

	user.save();

	const emailStatus = await passwordChangedEmailAlert(user, request);

	return sendSuccessResponse(reply, {
		statusCode: 200,
		message: "Password Updated",
		emailSuccess: emailStatus.success,
		emailMessage: emailStatus.message,
	});
};

// @route 	GET /api/v1/auth/account
// @desc 	Route used to get user Info
// @access	Private(requires JWT token in header)
const getAccount = async (request, reply) => {
	const user = request.user;
	return sendSuccessResponse(reply, {
		statusCode: 200,
		message: "User Found",
		name: user.name,
		email: request.userModel.email,
		role: user.role,
		isEmailConfirmed: user.isEmailConfirmed,
		isDeactivated: user.isDeactivated,
	});
};

// @route 	DELETE /api/v1/auth/account
// @desc 	Route used to DELETE user account
// @access	Private(requires JWT token in header)
const deleteAccount = async (request, reply) => {
	const user = request.userModel;
	const { password } = request.body;
	const checkPassword = await user.matchPasswd(password);

	if (!checkPassword) {
		return sendErrorResponse(
			reply,
			400,
			"We could not delete your account.Your entered the wrong password"
		);
	}

	// Log out of all devices
	await revokeAllRfTokenByUser(user, request.ipAddress);

	// Account is deactivated here, after 10 days
	// the accounts which are deactivated will be deleted
	// by the cron job
	user.isDeactivated = true;
	user.deactivatedAt = Date.now();

	user.save();

	return sendSuccessResponse(reply, {
		statusCode: 200,
		message:
			"Account deactivated. Your account will be deleted from the database after 10 days",
	});
};

// @route 	POST /api/v1/auth/refresh
// @desc 	Get new jwt token and refresh token from unused refresh token
//		 	(refresh token should be used only once)
// @access 	Private (JWT is not required but refresh token is required)
const getJWTFromRefresh = async (request, reply) => {
	// Fastify-cookie has a function which can be used to sign & unsign tokens
	// unsignCookie returns valid, renew & false
	// valid (boolean) : the cookie has been unsigned successfully
	// renew (boolean) : the cookie has been unsigned with an old secret
	// value (string/null) : if the cookie is valid then returns string else null

	const rft = getRftById(request.rtid);
	if (!rft) {
		return sendErrorResponse(reply, 400, "Invalid Refresh Token");
	}
	if (rft.isExpired()) {
		return sendErrorResponse(reply, 400, "Refresh Token Expired");
	}
	const user = await User.findById(rft.user);

	if (!user) {
		return sendErrorResponse(reply, 400, "Invalid Refresh Token");
	}

	const jwtToken = user.getJWT();
	rft.revoke(request.ipAddress);
	rft.save();
	const newRefreshToken = await getRefreshToken(user, request.ipAddress);

	return sendSuccessResponse(
		reply,
		{
			statusCode: 200,
			message: "Refresh token : successful",
			token: jwtToken,
		},
		{
			refreshToken: newRefreshToken,
		}
	);
};

// @route 	PUT /api/v1/auth/refresh/revoke
// @desc	revokes the refresh token. Used when logging out
// @access  Private(required JWT in authorization header)
const revokeRefreshToken = async (request, reply) => {
	const rft = getRftById(request.rtid);

	const sendInvalidToken = () => {
		return sendErrorResponse(reply, 400, "Invalid Refresh Token", {
			clearCookie: true,
		});
	};

	if (!rft) {
		sendInvalidToken();
	}

	const user = await User.findById(rft.user);

	if (!user) {
		sendInvalidToken();
	}

	if (user.uid !== request.user.uid) {
		// Check whether the refresh token was created by the same user
		sendInvalidToken();
	}

	if (rft.isExpired()) {
		return sendErrorResponse(reply, 400, "Refresh Token Expired", {
			clearCookie: true,
		});
	}
	rft.revoke(request.ipAddress);
	rft.save();
	return sendSuccessResponse(
		reply,
		{
			statusCode: 200,
			message: "Refresh token successfully revoked",
		},
		{ clearCookie: true }
	);
};

// @route 	PUT /api/v1/auth/revokeAll
// @desc 	Route used to log out of all devices , i.e
// 			revoke all refreshTokens
// @access	Private(requires JWT token in header)
const revokeAllRefreshTokens = async (request, reply) => {
	const user = request.userModel;
	await revokeAllRfTokenByUser(user);
	return sendSuccessResponse(reply, {
		statusCode: 200,
		message: "Successfully revoked all tokens",
	});
};

module.exports = {
	registerUser,
	confirmEmail,
	confirmEmailTokenRedirect,
	requestConfirmationEmail,
	requestResetPasswordToken,
	resetPasswordTokenRedirect,
	resetPasswordFromToken,
	updatePassword,
	signin,
	getJWTFromRefresh,
	revokeRefreshToken,
	revokeAllRefreshTokens,
	getAccount,
	deleteAccount,
};
