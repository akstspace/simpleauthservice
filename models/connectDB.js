const mongoose = require("mongoose");
const { configs } = require("../configs");

const connectDB = async () => {
	let options;
	if (configs.MONGO_URI === "mongodb://localhost:27017/") {
		options = {
			useNewUrlParser: true,
			useUnifiedTopology: true,
		};
	} else {
		options = {
			useNewUrlParser: true,
			useCreateIndex: true,
			useFindAndModify: false,
			useUnifiedTopology: true,
		};
	}
	const conn = await mongoose.connect(configs.MONGO_URI, options);

	console.log(`MongoDB Connected`);
};

module.exports = {
	connectDB,
};
