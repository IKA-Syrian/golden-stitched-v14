require('dotenv').config();
const fetch = require('node-fetch');
const Discord = require('discord.js');
const path = require('path');
const fs = require('fs');
const { exec, execSync } = require('child_process');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js')


async function executeCommand(commands, currentCommand, pinteraction, interaction, chDrivenum) {
    const { command, options, status} = commands[currentCommand];
    console.log(command + "\n")
    let option = {};
    if(options){
        option = options;
    }
    // console.log(interaction);
    // console.log(pinteraction.user);
    exec(command, option, async (error, stdout, stderr) => {
        if (error) {
            console.error(`exec error: ${error}`);
            interaction.followUp({content: "An error has occurred while processing the commands!" , ephemeral: true});
            return;
        }
        console.log(`stdout: ${stdout}`);
        console.log(`stderr: ${stderr}`);
        if(currentCommand === 4) {
            try {
                interaction.user.send(`chapter-${chDrivenum}: ${stdout}`);
                interaction.followUp({content: "See Your DM", ephemeral: true})
                const message = await interaction.fetchReply();
                message.react("✅");
            } catch (error) {
                console.error(error);
            }
        }
        if (currentCommand < commands.length - 1) {
                executeCommand(commands, currentCommand + 1, pinteraction, interaction, chDrivenum);
        }
    });
} 
module.exports = (client) => {
    client.on('interactionCreate', async interaction => {
        if (!interaction.isChatInputCommand()) return;
        const { commandName } = interaction;
        if(commandName == 'stitch'){
            const userID = interaction.user.id
            const link = interaction.options.getString('link')
            const height = interaction.options.getInteger('height')
            const format = interaction.options.getString('format')
            const width = interaction.options.getInteger('width')
            let fileID
            if(link.split('?id=').length == 2){
                fileID = link.split('?id=')[1]
            }else if(link.split('?usp=').length == 0){
                fileID = link.split('/')[5]
            }else if(link.split('?').length == 0){
                fileID = link.split('/')[5]
            }else{
                fileID = link.split('/')[5].split('?')[0]
            }
            const pinteraction = await interaction.deferReply("يرجى الإنتظار حتى يتم إرسال الشهادة");
            let folderName
            let folderName1
            const folderInfo = execSync(`gdrive info ${fileID}`)
            if (folderInfo) {
                const infoOutput = await Buffer.from(folderInfo, 'utf-8').toString()
                console.log(infoOutput)
                const timestamp = new Date().getTime()
                const arg = infoOutput.split("\n")
                const nameArgs = arg[1].split(": ")
                folderName = nameArgs[1] + "-" + timestamp
                folderName1 = nameArgs[1]
            }
            let outputPAth
            let StitchPath
            if(folderName1.includes(" ")){
                outputPAth = `/root/golden-stitched-v14/downloads/${userID}/${folderName.replace(/ /g, "_")}/"${folderName1}"/"${folderName1}_Stitched"/`
                console.log(outputPAth)
                StitchPath = `/root/golden-stitched-v14/downloads/${userID}/${folderName.replace(/ /g, "_")}/"${folderName1}"`
            }else{
                outputPAth = `/root/golden-stitched-v14/downloads/${userID}/${folderName}/${folderName1}/${folderName1}_Stitched`
                StitchPath = `/root/golden-stitched-v14/downloads/${userID}/${folderName}/${folderName1}`
            }
            const Dwnloadpath = path.join(__dirname, `./downloads/${userID}/${folderName.replace(/ /g, "_")}`)
            
            let commands
            if(width == null){
                commands = [
                    { 
                        command: `gdrive download ${fileID} --force --recursive --path ${Dwnloadpath} --skip`, 
                    },
                    {
                        command: `SmartStitch -i ${StitchPath} -sh ${height} -t .${format}`
                    },
                    {
                        command: `zip -r chapter-${folderName1.replace(/ /g, "_")}.zip *`, 
                        options: {
                            cwd: outputPAth
                        }
                    },
                    {
                        command: `gdrive upload ${outputPAth.valueOf()} -p 1cLYTxlhcn1KC85ROA6h8Hp1D3EfSPRGP --recursive`,  
                        status: 'Uploaded' 
                    },
                    {
                        command : `rclone link Golden1:/${folderName1.replace(/ /g, "_")}_Stitched`,
                    }
                ]
            }else{
                commands = [
                    { 
                        command: `gdrive download ${fileID} --force --recursive --path ${Dwnloadpath} --skip`, 
                        // status: 'All done!' 
                    },
                    {
                        command: `SmartStitch -i ${StitchPath} -sh ${height} -t .${format} -cw ${width}`
                    },
                    {
                        command: `zip -r chapter-${folderName1.replace(/ /g, "_")}.zip *`, 
                        options: {
                            cwd: outputPAth
                        }
                    },
                    {
                        command: `gdrive upload ${outputPAth.valueOf()} -p 1cLYTxlhcn1KC85ROA6h8Hp1D3EfSPRGP --recursive`,  
                        status: 'Uploaded' 
                    },
                    {
                        command : `rclone link Golden1:/${folderName1.replace(/ /g, "_")}_Stitched`,
                    }
                ]
            }
            let currentCommand = 0;
            executeCommand(commands, currentCommand, pinteraction, interaction, folderName1.valueOf())
        }
    })
}